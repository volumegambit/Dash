import { homedir } from 'node:os';
import {
  AuthStorage,
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
import type {
  AgentSession,
  AgentSessionEvent,
} from '@mariozechner/pi-coding-agent';
import type { AgentEvent as PiAgentEvent } from '@mariozechner/pi-agent-core';
import { getModel } from '@mariozechner/pi-ai';
import type { AssistantMessage, ImageContent, Model, Usage } from '@mariozechner/pi-ai';

import type { Logger } from '../logger.js';
import { createCreateSkillTool, createLoadSkillTool, scanSkillsDirectory } from '../skills/index.js';
import type { SkillDiscoveryResult } from '../skills/types.js';
import type {
  AgentBackend,
  AgentEvent,
  AgentState,
  DashAgentConfig,
  RunOptions,
} from '../types.js';

/** All built-in tool names supported by PiAgent */
const ALL_TOOL_NAMES = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'] as const;

/**
 * PiAgentBackend - AgentBackend implementation using the PiAgent SDK
 * (@mariozechner/pi-coding-agent) instead of OpenCode.
 *
 * Key design:
 * - Uses in-memory auth (no filesystem credential storage)
 * - Uses in-memory session management (no filesystem session persistence)
 * - Event queue pattern: subscribe() pushes events, run() yields from queue
 * - One AgentSession per backend instance (created in start())
 */
export class PiAgentBackend implements AgentBackend {
  readonly name = 'piagent';

  private session: AgentSession | null = null;
  private auth: AuthStorage | null = null;
  private abortRequested = false;

  /** Accumulated full text during a response, for the `response` event */
  private fullText = '';

  /** Track the compaction reason from auto_compaction_start for use in auto_compaction_end */
  private lastCompactionReason: 'threshold' | 'overflow' = 'threshold';

  constructor(
    private config: DashAgentConfig,
    private providerApiKeys: Record<string, string>,
    private logger?: Logger,
    private managedSkillsDir?: string,
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
  private resolveModel(modelStr: string): Model<any> {
    const slash = modelStr.indexOf('/');
    if (slash === -1) {
      throw new Error(
        `Model must be in "provider/model" format, got "${modelStr}". Example: "anthropic/claude-sonnet-4-20250514"`,
      );
    }
    const provider = modelStr.slice(0, slash);
    const modelId = modelStr.slice(slash + 1);
    return getModel(provider as any, modelId as any);
  }

  /**
   * Build the list of tools based on the config's tool names.
   * If no tools specified, uses all coding tools.
   */
  private buildTools(workspace: string) {
    const allowedNames = this.config.tools
      ? new Set(this.config.tools)
      : new Set(ALL_TOOL_NAMES);

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

    // Skill tools
    const hasSkillPaths = this.config.skills?.paths && this.config.skills.paths.length > 0;
    if (hasSkillPaths || this.managedSkillsDir) {
      tools.push(createLoadSkillTool(() => this.listSkills()));
    }
    if (allowedNames.has('create_skill') && this.managedSkillsDir) {
      tools.push(createCreateSkillTool(this.managedSkillsDir));
    }

    return tools;
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
    const tools = this.buildTools(workspace);

    const { session } = await createAgentSession({
      cwd: workspace,
      authStorage: this.auth,
      model,
      tools,
      sessionManager: SessionManager.inMemory(),
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

    // Resolve model from state (may differ from config model)
    const model = this.resolveModel(state.model);
    await this.session.setModel(model);

    // Set system prompt on the session's agent
    this.session.agent.setSystemPrompt(state.systemPrompt);

    // Event queue for bridging subscribe callback to async generator
    const queue: (AgentSessionEvent | { type: '__done__' } | { type: '__error__'; error: Error })[] = [];
    let resolve: (() => void) | null = null;

    const waitForEvent = (): Promise<void> =>
      new Promise<void>((r) => {
        if (queue.length > 0) {
          r();
        } else {
          resolve = r;
        }
      });

    const pushEvent = (event: AgentSessionEvent | { type: '__done__' } | { type: '__error__'; error: Error }) => {
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
    const promptPromise = this.session
      .prompt(state.message, { images })
      .catch((err) => {
        pushEvent({ type: '__error__', error: err instanceof Error ? err : new Error(String(err)) });
      });

    try {
      while (true) {
        if (options.signal?.aborted || this.abortRequested) break;

        await waitForEvent();

        while (queue.length > 0) {
          const event = queue.shift()!;

          if (event.type === '__done__') {
            return;
          }

          if (event.type === '__error__') {
            yield { type: 'error', error: (event as any).error };
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
        const ame = (event as any).assistantMessageEvent;
        if (!ame) return null;

        switch (ame.type) {
          case 'text_delta':
            this.fullText += ame.delta;
            return { type: 'text_delta', text: ame.delta };
          case 'thinking_delta':
            return { type: 'thinking_delta', text: ame.delta };
          case 'error': {
            const errorMsg = ame.error?.errorMessage ?? ame.error?.message ?? 'Unknown error';
            return { type: 'error', error: new Error(errorMsg) };
          }
          default:
            return null;
        }
      }

      case 'tool_execution_start': {
        const e = event as Extract<PiAgentEvent, { type: 'tool_execution_start' }>;
        return { type: 'tool_use_start', id: e.toolCallId, name: e.toolName };
      }

      case 'tool_execution_update': {
        const e = event as Extract<PiAgentEvent, { type: 'tool_execution_update' }>;
        return {
          type: 'tool_use_delta',
          partial_json: typeof e.partialResult === 'string'
            ? e.partialResult
            : JSON.stringify(e.partialResult),
        };
      }

      case 'tool_execution_end': {
        const e = event as Extract<PiAgentEvent, { type: 'tool_execution_end' }>;
        // Extract text content from the result
        let content: string;
        if (e.result && typeof e.result === 'object' && Array.isArray(e.result.content)) {
          content = e.result.content
            .filter((c: any) => c.type === 'text')
            .map((c: any) => c.text)
            .join('\n');
        } else {
          content = String(e.result ?? '');
        }
        return {
          type: 'tool_result',
          id: e.toolCallId,
          name: e.toolName,
          content,
          isError: e.isError,
        };
      }

      case 'message_end': {
        // Emit a response event with accumulated text and usage
        const msg = (event as any).message as AssistantMessage | undefined;
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
        const e = event as any;
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
        const e = event as any;
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
    this.auth = null;
    this.logger?.info('[PiAgent] Stopped');
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
