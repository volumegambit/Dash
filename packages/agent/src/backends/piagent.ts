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

import type { McpAgentContext, McpConfigStoreInterface, McpManager } from '@dash/mcp';
import {
  createMcpAddServerTool,
  createMcpListServersTool,
  createMcpRemoveServerTool,
} from '@dash/mcp';

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
const DEFAULT_TOOL_NAMES = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'] as const;

/**
 * Provider API keys can be supplied either as a static snapshot (tests,
 * one-shot agents) or as an async function that reads the current keys from
 * an external source (e.g. the gateway credential store). When a function is
 * supplied, PiAgentBackend invokes it before each `run()` so credential
 * rotation, OAuth refresh, and key deletion are picked up without any
 * explicit update call.
 */
export type ProviderApiKeysSource =
  | Record<string, string>
  | (() => Promise<Record<string, string>>);

/**
 * PiAgentBackend - AgentBackend implementation using the PiAgent SDK
 * (@mariozechner/pi-coding-agent).
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

  /**
   * Current provider API keys — populated from the source (snapshot or
   * function) on each resolve. Used by `setupAuth()` and redaction logs.
   */
  private providerApiKeys: Record<string, string> = {};

  /** Hash of the last resolved keys, used to skip redundant auth rebuilds. */
  private lastKeysHash = '';

  constructor(
    private config: DashAgentConfig,
    private providerApiKeysSource: ProviderApiKeysSource,
    private logger?: Logger,
    private sessionDir?: string,
    private managedSkillsDir?: string,
    private mcpManager?: McpManager,
    private mcpConfigStore?: McpConfigStoreInterface,
    private mcpAgentContext?: McpAgentContext,
  ) {}

  /**
   * Resolve the current provider keys from the source. Snapshot callers get
   * the same object every time; function callers get whatever the provider
   * returns now. The result is cached in `this.providerApiKeys` for use by
   * `setupAuth()` and log redaction.
   */
  private async resolveProviderKeys(): Promise<Record<string, string>> {
    const keys =
      typeof this.providerApiKeysSource === 'function'
        ? await this.providerApiKeysSource()
        : this.providerApiKeysSource;
    this.providerApiKeys = keys;
    return keys;
  }

  /**
   * Return a stable hash of the current provider keys so we can detect when
   * they've changed and only rebuild auth when needed.
   */
  private hashKeys(keys: Record<string, string>): string {
    const sorted = Object.keys(keys).sort();
    return sorted.map((p) => `${p}=${keys[p]}`).join('|');
  }

  /**
   * Pull fresh provider credentials from the source and apply them to the
   * live AuthStorage if they've changed. Called at the start of every
   * `run()` so any store mutation (add, update, delete, OAuth refresh) takes
   * effect on the next turn without any explicit push.
   *
   * Exposed for tests — production code should not need to call this
   * directly; `run()` invokes it automatically.
   */
  async refreshCredentials(): Promise<void> {
    if (!this.auth) {
      this.logger?.warn(
        '[PiAgent] refreshCredentials: auth not initialized, skipping (call start() first)',
      );
      return;
    }
    const keys = await this.resolveProviderKeys();
    const currentHash = this.hashKeys(keys);
    if (currentHash === this.lastKeysHash) return;

    this.logger?.info(
      `[PiAgent] Credentials changed, refreshing auth: ${PiAgentBackend.redactKeys(keys)}`,
    );
    this.applyKeysToAuth(this.auth, keys);
    this.lastKeysHash = currentHash;
  }

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
    this.applyKeysToAuth(auth, this.providerApiKeys);
    return auth;
  }

  /**
   * Apply a fresh provider key map to an existing AuthStorage, replacing all
   * previous credentials. Used both by `setupAuth()` (initial population) and
   * by the pull-based refresh in `run()` to handle rotation AND deletion.
   *
   * This mutates `auth` in place — important because `createAgentSession`
   * captures a reference to the storage at construction time.
   */
  private applyKeysToAuth(auth: AuthStorage, keys: Record<string, string>): void {
    // Remove providers that are no longer present so deleted keys stop working
    const existing = auth.list();
    const desired = new Set(Object.keys(keys).filter((p) => keys[p]));
    for (const provider of existing) {
      if (!desired.has(provider)) {
        auth.remove(provider);
        this.logger?.info(`[PiAgent] Auth removed for provider: ${provider}`);
      }
    }

    // Set (or overwrite) every desired provider
    for (const [provider, key] of Object.entries(keys)) {
      if (!key) {
        this.logger?.warn(`[PiAgent] Skipping provider ${provider}: empty key`);
        continue;
      }

      if (PiAgentBackend.isOAuthToken(key)) {
        // OAuthCredential shape: { type: 'oauth', access, refresh, expires }
        const oneYearMs = 365 * 24 * 60 * 60 * 1000;
        auth.set(provider, {
          type: 'oauth',
          access: key,
          refresh: '',
          expires: Date.now() + oneYearMs,
        });
      } else {
        auth.set(provider, { type: 'api_key', key });
      }

      this.logger?.info(`[PiAgent] Auth set for provider: ${provider}`);
    }
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
    const allowedNames = this.config.tools
      ? new Set(this.config.tools)
      : new Set(DEFAULT_TOOL_NAMES);

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
    for (const name of DEFAULT_TOOL_NAMES) {
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
    const allowedNames = this.config.tools
      ? new Set(this.config.tools)
      : new Set(DEFAULT_TOOL_NAMES);
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

    // MCP server tools (from connected MCP servers, filtered by agent's assigned servers)
    if (allowedNames.has('mcp') && this.mcpManager) {
      const assigned = this.config.assignedMcpServers;
      if (assigned && assigned.length > 0) {
        const assignedSet = new Set(assigned);
        customs.push(
          ...this.mcpManager.getTools().filter((t) => {
            const serverName = t.name.split('__')[0];
            return assignedSet.has(serverName);
          }),
        );
      } else if (!assigned) {
        // No assignedMcpServers field = legacy/standalone mode, show all
        customs.push(...this.mcpManager.getTools());
      }
      // assignedMcpServers = [] means explicitly no servers assigned
    }

    // MCP management tools (add/remove/list servers)
    if (this.mcpManager && this.mcpConfigStore && this.mcpAgentContext) {
      const onToolsChanged = () => this.syncMcpToolsToSession();

      if (allowedNames.has('mcp_add_server')) {
        customs.push(
          wrap(
            createMcpAddServerTool({
              manager: this.mcpManager,
              configStore: this.mcpConfigStore,
              agentContext: this.mcpAgentContext,
              logger: this.logger,
              onToolsChanged,
            }),
          ),
        );
      }
      if (allowedNames.has('mcp_list_servers')) {
        customs.push(
          wrap(
            createMcpListServersTool({
              manager: this.mcpManager,
              configStore: this.mcpConfigStore,
              agentContext: this.mcpAgentContext,
            }),
          ),
        );
      }
      if (allowedNames.has('mcp_remove_server')) {
        customs.push(
          wrap(
            createMcpRemoveServerTool({
              manager: this.mcpManager,
              configStore: this.mcpConfigStore,
              agentContext: this.mcpAgentContext,
              logger: this.logger,
              onToolsChanged,
            }),
          ),
        );
      }
    }

    return customs;
  }

  /**
   * Sync MCP tools into the live Pi session after mcp_add_server / mcp_remove_server.
   *
   * Pi's AgentSession freezes customTools at construction time. When the agent
   * adds or removes an MCP server mid-conversation, the new tools aren't visible
   * to the LLM. This method rebuilds the custom tool list and pokes it into the
   * session's internal registry so tools are available on the next LLM turn.
   */
  private syncMcpToolsToSession(): void {
    if (!this.session) return;

    const customTools = this.buildCustomTools();
    this.logger?.info(
      `[PiAgent] Syncing ${customTools.length} custom tools to live session: ${customTools.map((t: { name: string }) => t.name).join(', ')}`,
    );

    // Pi's _customTools and _refreshToolRegistry are private, but we need to
    // update them at runtime to register dynamically-added MCP server tools.
    // biome-ignore lint/suspicious/noExplicitAny: accessing private Pi session internals for dynamic tool sync
    const session = this.session as any;
    session._customTools = customTools;
    session._refreshToolRegistry();
  }

  /**
   * Start the backend by creating a PiAgent session.
   */
  async start(workspace: string): Promise<void> {
    // Resolve credentials from the source (snapshot or provider function).
    const keys = await this.resolveProviderKeys();
    this.lastKeysHash = this.hashKeys(keys);
    this.logger?.info(
      `[PiAgent] Starting with credentials: ${PiAgentBackend.redactKeys(keys)}`,
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

    // Pull fresh credentials from the source. When the source is a function
    // (e.g. the gateway credential store reader), this picks up rotation,
    // OAuth refresh, and key deletion without any explicit update call.
    await this.refreshCredentials();

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
        // Emit a response event with accumulated text and usage, or an error
        // event if the model call failed. PiAgent reports upstream API errors
        // (e.g. Anthropic 401 auth failures) via `stopReason: 'error'` on the
        // assistant message — if we don't surface these, the chat UI just sees
        // an empty response and the user has no idea what went wrong.
        const endEvent = event as Extract<AgentSessionEvent, { type: 'message_end' }>;
        const msg = endEvent.message as
          | (AssistantMessage & { stopReason?: string; errorMessage?: string })
          | undefined;
        if (msg?.stopReason === 'error') {
          const errMsg = msg.errorMessage ?? 'Model call failed';
          return { type: 'error', error: new Error(errMsg) };
        }
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
