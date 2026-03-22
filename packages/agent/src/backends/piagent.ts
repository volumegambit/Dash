import { homedir } from 'node:os';
import { dirname } from 'node:path';
import type { AgentEvent as PiAgentEvent } from '@mariozechner/pi-agent-core';
import { getModel } from '@mariozechner/pi-ai';
import type { Api, AssistantMessage, ImageContent, Model, Usage } from '@mariozechner/pi-ai';
import {
  AuthStorage,
  DefaultResourceLoader,
  SessionManager,
  createAgentSession,
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
} from '@mariozechner/pi-coding-agent';
import type { AgentSession, AgentSessionEvent, Skill } from '@mariozechner/pi-coding-agent';

import type { McpManager } from '@dash/mcp';

import type { Logger } from '../logger.js';
import {
  createCreateSkillTool,
  createLoadSkillTool,
  scanSkillsDirectory,
} from '../skills/index.js';
import type { SkillDiscoveryResult } from '../skills/types.js';
import { BraveSearchProvider } from '../tools/search-providers/brave.js';
import { createTodoWriteTool } from '../tools/todowrite.js';
import { createWebFetchTool } from '../tools/web-fetch.js';
import { createWebSearchTool } from '../tools/web-search.js';
import type {
  AgentBackend,
  AgentEvent,
  AgentState,
  DashAgentConfig,
  RunOptions,
} from '../types.js';
import { DashResourceLoader } from './dash-resource-loader.js';

/** All built-in tool names supported by PiAgent */
const ALL_TOOL_NAMES = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'] as const;

/**
 * PiAgentBackend - AgentBackend implementation using the PiAgent SDK
 * (@mariozechner/pi-coding-agent) instead of OpenCode.
 *
 * Key design:
 * - Uses in-memory auth (no filesystem credential storage)
 * - Session management: in-memory by default, or persistent when `sessionDir` is provided.
 *   When `sessionDir` is set, uses `SessionManager.continueRecent()` to resume the most
 *   recent session from disk (or create a new one if none exists).
 * - Event queue pattern: subscribe() pushes events, run() yields from queue
 * - One AgentSession per backend instance (created in start())
 */
export class PiAgentBackend implements AgentBackend {
  readonly name = 'piagent';

  private session: AgentSession | null = null;
  private auth: AuthStorage | null = null;
  private abortRequested = false;
  private ownsMcpManager = false;
  private resourceLoader: DashResourceLoader | null = null;

  /** Accumulated full text during a response, for the `response` event */
  private fullText = '';

  /** Track the compaction reason from auto_compaction_start for use in auto_compaction_end */
  private lastCompactionReason: 'threshold' | 'overflow' = 'threshold';

  constructor(
    private config: DashAgentConfig,
    private providerApiKeys: Record<string, string>,
    private logger?: Logger,
    private sessionDir?: string,
    private managedSkillsDir?: string,
    private mcpManager?: McpManager,
  ) {}

  /** Detect OAuth access tokens (e.g. sk-ant-oat01-...) vs regular API keys */
  private static isOAuthToken(key: string): boolean {
    return key.startsWith('sk-ant-oat');
  }

  /** Returns a redacted summary of provider keys for logging */
  private static redactKeys(keys: Record<string, string>): string {
    return Object.entries(keys)
      .map(([provider, key]) => {
        if (!key) return `${provider}:(empty)`;
        const prefix = key.slice(0, 6);
        const suffix = key.slice(-10);
        const authType = PiAgentBackend.isOAuthToken(key) ? 'oauth' : 'api';
        return `${provider}:${prefix}***${suffix} (${authType})`;
      })
      .join(', ');
  }

  /**
   * Set up auth storage with the provided API keys.
   * Uses runtime API key overrides (not persisted to disk).
   */
  private setupAuth(): AuthStorage {
    const auth = AuthStorage.inMemory();

    for (const [provider, key] of Object.entries(this.providerApiKeys)) {
      if (!key) {
        this.logger?.warn(`[PiAgent] Skipping provider ${provider}: empty key`);
        continue;
      }

      if (PiAgentBackend.isOAuthToken(key)) {
        // OAuth tokens: set as OAuth credential
        // OAuthCredential shape: { type: 'oauth', access, refresh, expires }
        const oneYearMs = 365 * 24 * 60 * 60 * 1000;
        auth.set(provider, {
          type: 'oauth',
          access: key,
          refresh: '',
          expires: Date.now() + oneYearMs,
        });
      } else {
        // Regular API keys
        auth.set(provider, { type: 'api_key', key });
      }

      this.logger?.info(`[PiAgent] Auth set for provider: ${provider}`);
    }

    return auth;
  }

  /**
   * Resolve the model from "provider/model-id" format.
   */
  private resolveModel(modelStr: string): Model<Api> {
    const slash = modelStr.indexOf('/');
    if (slash === -1) {
      throw new Error(
        `Model must be in "provider/model" format, got "${modelStr}". Example: "anthropic/claude-sonnet-4-20250514"`,
      );
    }
    const provider = modelStr.slice(0, slash);
    const modelId = modelStr.slice(slash + 1);
    // biome-ignore lint/suspicious/noExplicitAny: getModel requires generic provider/modelId that are not statically known
    return getModel(provider as any, modelId as any);
  }

  /**
   * Build the built-in PiAgent tools based on the config's tool names.
   * These go in createAgentSession({ tools }) — PiAgent recognizes them by name.
   */
  private buildBuiltinTools(workspace: string) {
    const allowedNames = this.config.tools ? new Set(this.config.tools) : new Set(ALL_TOOL_NAMES);

    // biome-ignore lint/suspicious/noExplicitAny: Tool type not exported from pi-coding-agent top-level
    const toolBuilders: Record<string, () => any> = {
      read: () => createReadTool(workspace),
      bash: () => createBashTool(workspace),
      edit: () => createEditTool(workspace),
      write: () => createWriteTool(workspace),
      grep: () => createGrepTool(workspace),
      find: () => createFindTool(workspace),
      ls: () => createLsTool(workspace),
    };

    const tools = [];
    for (const name of ALL_TOOL_NAMES) {
      if (allowedNames.has(name) && toolBuilders[name]) {
        tools.push(toolBuilders[name]());
      }
    }

    return tools;
  }

  /**
   * Build custom tools (web, task, skills).
   * These go in createAgentSession({ customTools }) — registered via the extension system.
   * AgentTool instances are wrapped as ToolDefinition (adds unused ctx parameter).
   */
  // biome-ignore lint/suspicious/noExplicitAny: tool types from pi-coding-agent SDK lack exported interfaces
  private buildCustomTools(): any[] {
    const allowedNames = this.config.tools ? new Set(this.config.tools) : new Set(ALL_TOOL_NAMES);
    // biome-ignore lint/suspicious/noExplicitAny: tool types from pi-coding-agent SDK lack exported interfaces
    const customs: any[] = [];

    // biome-ignore lint/suspicious/noExplicitAny: tool types from pi-coding-agent SDK lack exported interfaces
    const wrap = (tool: any) => ({
      name: tool.name,
      label: tool.label,
      description: tool.description,
      parameters: tool.parameters,
      execute: (
        toolCallId: string,
        // biome-ignore lint/suspicious/noExplicitAny: tool param types from SDK are not exported
        params: any,
        signal?: AbortSignal,
        // biome-ignore lint/suspicious/noExplicitAny: onUpdate callback type from SDK is not exported
        onUpdate?: any,
        // biome-ignore lint/suspicious/noExplicitAny: ctx type from SDK is not exported
        _ctx?: any,
      ) => tool.execute(toolCallId, params, signal, onUpdate),
    });

    // ── Core tools (always registered, not user-configurable) ──────────
    // These are essential agent capabilities that are always available
    // regardless of the operator's tool selection.
    customs.push(wrap(createTodoWriteTool())); // task tracking

    const hasSkillPaths = this.config.skills?.paths && this.config.skills.paths.length > 0;
    if (hasSkillPaths || this.managedSkillsDir) {
      customs.push(wrap(createLoadSkillTool(() => this.listSkills()))); // skill loading
    }

    // ── User-configurable tools (gated by allowedNames) ──────────────
    if (allowedNames.has('web_fetch')) {
      customs.push(wrap(createWebFetchTool()));
    }
    if (allowedNames.has('web_search')) {
      const braveKey = this.providerApiKeys.brave ?? this.providerApiKeys['brave-api-key'];
      const provider = braveKey ? new BraveSearchProvider(braveKey) : null;
      customs.push(wrap(createWebSearchTool(provider)));
    }

    // Skill creation (opt-in)
    if (allowedNames.has('create_skill') && this.managedSkillsDir) {
      customs.push(wrap(createCreateSkillTool(this.managedSkillsDir)));
    }

    // MCP tools
    if (allowedNames.has('mcp') && this.mcpManager) {
      customs.push(...this.mcpManager.getTools());
    }

    return customs;
  }

  /**
   * Start the backend by creating a PiAgent session.
   */
  async start(workspace: string): Promise<void> {
    this.logger?.info(
      `[PiAgent] Starting with credentials: ${PiAgentBackend.redactKeys(this.providerApiKeys)}`,
    );

    this.auth = this.setupAuth();
    const model = this.resolveModel(this.config.model);

    // MCP: create manager if not injected and servers are configured
    if (!this.mcpManager && this.config.mcpServers?.length) {
      const { McpManager: McpMgr } = await import('@dash/mcp');
      this.mcpManager = new McpMgr(this.config.mcpServers, { logger: this.logger });
      await this.mcpManager.start();
      this.ownsMcpManager = true;
    }

    const builtinTools = this.buildBuiltinTools(workspace);
    const customTools = this.buildCustomTools();
    this.logger?.info(
      `[PiAgent] Registering ${builtinTools.length} built-in tools: ${builtinTools.map((t: { name: string }) => t.name).join(', ')}`,
    );
    this.logger?.info(
      `[PiAgent] Registering ${customTools.length} custom tools: ${customTools.map((t: { name: string }) => t.name).join(', ')}`,
    );

    // Create a resource loader that pi will use to build the system prompt.
    // We wrap it with DashResourceLoader so we can inject Dash's system prompt
    // and managed skills dynamically. Pi's _baseSystemPrompt reads from here.
    //
    // Disable all pi-native resource discovery (skills, extensions, prompts, themes)
    // so the gateway has full control. Pi's user settings (~/.pi/agent/settings.json),
    // project settings (<cwd>/.pi/), and ~/.agents/ would otherwise silently influence
    // agent behavior in unpredictable ways. All skill injection goes through
    // DashResourceLoader.setExtraSkills() instead.
    const innerLoader = new DefaultResourceLoader({
      cwd: workspace,
      systemPrompt: this.config.systemPrompt,
      noSkills: true,
      noExtensions: true,
      noPromptTemplates: true,
      noThemes: true,
    });
    await innerLoader.reload();
    this.resourceLoader = new DashResourceLoader(innerLoader);

    // Pre-populate with Dash's managed skills
    const dashSkills = await this.listSkillsAsPiSkills();
    this.resourceLoader.setExtraSkills(dashSkills);
    this.logger?.info(`[PiAgent] Injecting ${dashSkills.length} Dash skills into resource loader`);

    const { session } = await createAgentSession({
      cwd: workspace,
      authStorage: this.auth,
      model,
      tools: builtinTools,
      customTools,
      resourceLoader: this.resourceLoader,
      sessionManager: this.sessionDir
        ? SessionManager.continueRecent(workspace, this.sessionDir)
        : SessionManager.inMemory(),
    });

    this.session = session;
    this.logger?.info('[PiAgent] Session created successfully');
  }

  /**
   * Run the agent with the given state. Yields normalized AgentEvents.
   *
   * Design:
   * 1. Subscribe to session events, pushing them to a queue
   * 2. Fire session.prompt() (runs concurrently)
   * 3. Pull from the queue and yield normalized events
   * 4. Return when agent_end is received
   */
  async *run(state: AgentState, options: RunOptions): AsyncGenerator<AgentEvent> {
    if (!this.session) {
      throw new Error('PiAgentBackend not started. Call start() first.');
    }

    this.abortRequested = false;
    this.fullText = '';
    this.lastCompactionReason = 'threshold';

    // Emit mcp_server_error events for any servers that failed during start
    if (this.mcpManager) {
      for (const failed of this.mcpManager.getFailedServers()) {
        yield { type: 'mcp_server_error' as const, server: failed.name, error: failed.error };
      }
    }

    // Resolve model from state (may differ from config model)
    const model = this.resolveModel(state.model);
    await this.session.setModel(model);

    // Update the resource loader with the current system prompt and skills,
    // then trigger a _baseSystemPrompt rebuild via setActiveToolsByName.
    // This ensures pi's session.prompt() uses the correct prompt instead of
    // overwriting Dash's prompt with its own _baseSystemPrompt.
    if (this.resourceLoader) {
      this.resourceLoader.setSystemPrompt(state.systemPrompt);
      const dashSkills = await this.listSkillsAsPiSkills();
      this.resourceLoader.setExtraSkills(dashSkills);
      // Force pi to rebuild _baseSystemPrompt from the updated resource loader
      this.session.setActiveToolsByName(this.session.getActiveToolNames());
    }

    // Event queue for bridging subscribe callback to async generator
    const queue: (
      | AgentSessionEvent
      | { type: '__done__' }
      | { type: '__error__'; error: Error }
    )[] = [];
    let resolve: (() => void) | null = null;

    const waitForEvent = (): Promise<void> =>
      new Promise<void>((r) => {
        if (queue.length > 0) {
          r();
        } else {
          resolve = r;
        }
      });

    const pushEvent = (
      event: AgentSessionEvent | { type: '__done__' } | { type: '__error__'; error: Error },
    ) => {
      queue.push(event);
      if (resolve) {
        const r = resolve;
        resolve = null;
        r();
      }
    };

    // Subscribe to session events
    const unsubscribe = this.session.subscribe((event: AgentSessionEvent) => {
      pushEvent(event);
      if (event.type === 'agent_end') {
        pushEvent({ type: '__done__' });
      }
    });

    // Convert Dash ImageBlock[] to PiAgent ImageContent[]
    const images: ImageContent[] | undefined = state.images?.map((img) => ({
      type: 'image' as const,
      data: img.data,
      mimeType: img.mediaType,
    }));

    // Fire prompt (runs concurrently with event consumption)
    const promptPromise = this.session.prompt(state.message, { images }).catch((err) => {
      pushEvent({ type: '__error__', error: err instanceof Error ? err : new Error(String(err)) });
    });

    try {
      while (true) {
        if (options.signal?.aborted || this.abortRequested) break;

        await waitForEvent();

        while (queue.length > 0) {
          const event = queue.shift();
          if (!event) break;

          if (event.type === '__done__') {
            return;
          }

          if (event.type === '__error__') {
            yield { type: 'error', error: (event as { type: '__error__'; error: Error }).error };
            return;
          }

          const normalized = this.normalizeEvent(event as AgentSessionEvent);
          if (normalized !== null) {
            yield normalized;
          }
        }
      }
    } finally {
      unsubscribe();
      await promptPromise;
    }
  }

  /**
   * Normalize a PiAgent session event to a Dash AgentEvent.
   * Returns null for events that don't map to any Dash event.
   */
  normalizeEvent(event: AgentSessionEvent): AgentEvent | null {
    switch (event.type) {
      case 'message_update': {
        const ame = (event as Extract<AgentSessionEvent, { type: 'message_update' }>)
          .assistantMessageEvent;
        if (!ame) return null;

        switch (ame.type) {
          case 'text_delta':
            this.fullText += ame.delta;
            return { type: 'text_delta', text: ame.delta };
          case 'thinking_delta':
            return { type: 'thinking_delta', text: ame.delta };
          case 'error': {
            const errorMsg = ame.error?.errorMessage ?? 'Unknown error';
            return { type: 'error', error: new Error(errorMsg) };
          }
          default:
            return null;
        }
      }

      case 'tool_execution_start': {
        const e = event as Extract<PiAgentEvent, { type: 'tool_execution_start' }>;
        const input =
          e.args && typeof e.args === 'object' && !Array.isArray(e.args)
            ? (e.args as Record<string, unknown>)
            : undefined;
        return { type: 'tool_use_start', id: e.toolCallId, name: e.toolName, input };
      }

      case 'tool_execution_update': {
        const e = event as Extract<PiAgentEvent, { type: 'tool_execution_update' }>;
        return {
          type: 'tool_use_delta',
          partial_json:
            typeof e.partialResult === 'string' ? e.partialResult : JSON.stringify(e.partialResult),
        };
      }

      case 'tool_execution_end': {
        const e = event as Extract<PiAgentEvent, { type: 'tool_execution_end' }>;
        // Extract text content from the result
        let content: string;
        if (e.result && typeof e.result === 'object' && Array.isArray(e.result.content)) {
          content = (e.result.content as { type: string; text: string }[])
            .filter((c) => c.type === 'text')
            .map((c) => c.text)
            .join('\n');
        } else {
          content = String(e.result ?? '');
        }
        // Extract details (e.g. diff from Edit tool) if present
        const rawDetails =
          e.result && typeof e.result === 'object' && 'details' in e.result
            ? (e.result as { details?: unknown }).details
            : undefined;
        // Only include details if it has meaningful content (skip empty objects)
        const hasDetails =
          rawDetails !== undefined &&
          rawDetails !== null &&
          !(typeof rawDetails === 'object' && Object.keys(rawDetails as object).length === 0);
        return {
          type: 'tool_result',
          id: e.toolCallId,
          name: e.toolName,
          content,
          isError: e.isError,
          ...(hasDetails ? { details: rawDetails } : {}),
        };
      }

      case 'message_end': {
        // Emit a response event with accumulated text and usage
        const endEvent = event as Extract<AgentSessionEvent, { type: 'message_end' }>;
        const msg = endEvent.message as AssistantMessage | undefined;
        const usage: Usage | undefined = msg?.usage;
        return {
          type: 'response',
          content: this.fullText,
          usage: {
            inputTokens: usage?.input ?? 0,
            outputTokens: usage?.output ?? 0,
            cacheReadTokens: usage?.cacheRead,
            cacheWriteTokens: usage?.cacheWrite,
          },
        };
      }

      case 'auto_compaction_start': {
        const e = event as Extract<AgentSessionEvent, { type: 'auto_compaction_start' }>;
        this.lastCompactionReason = e.reason ?? 'threshold';
        return null;
      }

      case 'auto_compaction_end': {
        return {
          type: 'context_compacted',
          overflow: this.lastCompactionReason === 'overflow',
        };
      }

      case 'auto_retry_start': {
        const e = event as Extract<AgentSessionEvent, { type: 'auto_retry_start' }>;
        return {
          type: 'agent_retry',
          attempt: e.attempt ?? 1,
          reason: e.errorMessage ?? 'unknown',
        };
      }

      default:
        return null;
    }
  }

  /**
   * Abort the current prompt.
   */
  abort(): void {
    this.abortRequested = true;
    if (this.session) {
      // session.abort() returns a promise but we fire-and-forget
      this.session.abort().catch(() => {});
    }
  }

  /**
   * Update provider API keys at runtime.
   */
  async updateCredentials(providerApiKeys: Record<string, string>): Promise<void> {
    this.logger?.info(
      `[PiAgent] updateCredentials called: ${PiAgentBackend.redactKeys(providerApiKeys)}`,
    );
    this.providerApiKeys = providerApiKeys;

    if (this.auth) {
      for (const [provider, key] of Object.entries(providerApiKeys)) {
        if (!key) continue;
        if (PiAgentBackend.isOAuthToken(key)) {
          const oneYearMs = 365 * 24 * 60 * 60 * 1000;
          this.auth.set(provider, {
            type: 'oauth',
            access: key,
            refresh: '',
            expires: Date.now() + oneYearMs,
          });
        } else {
          this.auth.set(provider, { type: 'api_key', key });
        }
        this.logger?.info(`[PiAgent] Auth updated for provider: ${provider}`);
      }
    } else {
      this.logger?.warn(
        '[PiAgent] updateCredentials: auth not initialized, keys stored for next start',
      );
    }
  }

  /**
   * Clean up session resources.
   */
  async stop(): Promise<void> {
    if (this.session) {
      this.session.dispose();
      this.session = null;
    }
    if (this.ownsMcpManager && this.mcpManager) {
      await this.mcpManager.stop();
      this.mcpManager = undefined;
    }
    this.auth = null;
    this.resourceLoader = null;
    this.logger?.info('[PiAgent] Stopped');
  }

  /**
   * Convert Dash's discovered skills to pi's Skill format for the resource loader.
   */
  private async listSkillsAsPiSkills(): Promise<Skill[]> {
    const dashSkills = await this.listSkills();
    return dashSkills.map((s) => ({
      name: s.name,
      description: s.description,
      filePath: s.location,
      baseDir: dirname(s.location),
      source: s.source,
      disableModelInvocation: false,
    }));
  }

  /**
   * Discover skills from the managed directory and configured paths.
   */
  async listSkills(): Promise<SkillDiscoveryResult[]> {
    const results: SkillDiscoveryResult[] = [];

    // Scan managed directory
    if (this.managedSkillsDir) {
      const managed = await scanSkillsDirectory(this.managedSkillsDir, 'managed');
      results.push(...managed);
    }

    // Scan configured paths
    const paths = this.config.skills?.paths ?? [];
    const existingNames = new Set(results.map((r) => r.name));
    for (const p of paths) {
      const expanded = p.startsWith('~/') ? p.replace('~', homedir()) : p;
      const scanned = await scanSkillsDirectory(expanded, 'managed');
      for (const skill of scanned) {
        if (!existingNames.has(skill.name)) {
          results.push(skill);
          existingNames.add(skill.name);
        }
      }
    }

    return results;
  }
}
