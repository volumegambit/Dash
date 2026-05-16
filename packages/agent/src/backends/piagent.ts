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
} from '@mariozechner/pi-coding-agent';
import type { AgentSession, AgentSessionEvent, Skill } from '@mariozechner/pi-coding-agent';

import type { McpAgentContext, McpConfigStoreInterface, McpManager } from '@dash/mcp';

import type { Logger } from '../logger.js';
import { scanSkillsDirectory } from '../skills/index.js';
import type { SkillDiscoveryResult } from '../skills/types.js';
import {
  DEFAULT_ALLOWED_TOOL_NAMES,
  createDefaultToolRegistry,
  resolveAllowedToolNames,
} from '../tools/default-registry.js';
import type { ToolFactoryContext, ToolRegistry } from '../tools/registry.js';
import type {
  AgentBackend,
  AgentEvent,
  AgentState,
  DashAgentConfig,
  RunOptions,
} from '../types.js';
import { DashResourceLoader } from './dash-resource-loader.js';

/** All built-in tool names supported by PiAgent (re-exported for callers that
 * still depend on this constant by name; the canonical list now lives in
 * `tools/default-registry.ts`). */
const DEFAULT_TOOL_NAMES = DEFAULT_ALLOWED_TOOL_NAMES;

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
   * Workspace directory the session was started with. Cached at `start()`
   * so `syncMcpToolsToSession()` can rebuild the tool list (which needs a
   * context with the workspace, even though no custom tool actually uses
   * it today).
   */
  private currentWorkspace = '';

  /**
   * Current provider API keys — populated from the source (snapshot or
   * function) on each resolve. Used by `setupAuth()` and redaction logs.
   */
  private providerApiKeys: Record<string, string> = {};

  /**
   * Snapshot of the last keys we **applied to the live AuthStorage from the
   * store**. Compared against the current store values on each refresh so
   * we only re-apply when the store has actually changed.
   *
   * Why this matters: pi's AuthStorage has a built-in OAuth refresh path
   * that mutates auth in memory when an access token is about to expire.
   * If we naively re-applied the store value on every `run()`, we would
   * overwrite those refreshed tokens with the stale (pre-refresh) raw
   * token from the store, causing the next model call to 401. By comparing
   * to `lastAppliedKeys` — which represents what the store contained the
   * last time WE touched auth — we only overwrite when the user has
   * actually mutated the store (add / rotate / delete), leaving pi's
   * internal refreshes alone.
   *
   * This is NOT a hash; it's a direct deep-equal comparison, so there's
   * no collision risk (e.g. from base64 `=` in key values).
   */
  private lastAppliedKeys: Record<string, string> = {};

  /**
   * Registry of tool factories used to build the built-in and custom tool
   * lists for every session. Defaults to `createDefaultToolRegistry()` —
   * pass a custom registry to add, replace, or remove tools without
   * subclassing.
   */
  private readonly toolRegistry: ToolRegistry;

  constructor(
    private config: DashAgentConfig,
    private providerApiKeysSource: ProviderApiKeysSource,
    private logger?: Logger,
    private sessionDir?: string,
    private managedSkillsDir?: string,
    private mcpManager?: McpManager,
    private mcpConfigStore?: McpConfigStoreInterface,
    private mcpAgentContext?: McpAgentContext,
    toolRegistry?: ToolRegistry,
  ) {
    this.toolRegistry = toolRegistry ?? createDefaultToolRegistry();
  }

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
   * Pull fresh provider credentials from the source and apply them to the
   * live AuthStorage if the store has changed since our last apply. Called
   * at the start of every `run()` so user mutations (add, rotate, delete,
   * re-auth) take effect on the next turn without any explicit push.
   *
   * Only applies when the store value differs from `lastAppliedKeys` — this
   * is what preserves pi's internal OAuth token refreshes. See the
   * `lastAppliedKeys` field comment for the full rationale.
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
    if (PiAgentBackend.keysEqual(keys, this.lastAppliedKeys)) {
      // Store unchanged since last apply — leave auth alone so any OAuth
      // token refreshes pi has performed in-memory are preserved.
      return;
    }
    this.logger?.info(
      `[PiAgent] Store credentials changed, refreshing auth: ${PiAgentBackend.redactKeys(keys)}`,
    );
    this.applyKeysToAuth(this.auth, keys);
    this.lastAppliedKeys = { ...keys };
  }

  /**
   * Direct deep equality check for {provider: value} maps. Used to decide
   * whether the credential store has changed since the last apply.
   * Intentionally NOT a hash — we want byte-exact comparison so two
   * genuinely different key maps can never be treated as equal.
   */
  private static keysEqual(a: Record<string, string>, b: Record<string, string>): boolean {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    for (const k of aKeys) {
      if (a[k] !== b[k]) return false;
    }
    return true;
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
    const model = getModel(provider as any, modelId as any);
    if (!model) {
      throw new Error(
        `Unknown model "${modelStr}". Check that the provider and model ID are correct.`,
      );
    }
    return model;
  }

  /**
   * Build the `ToolFactoryContext` used by every registry call. Capturing
   * this once per build keeps the gating logic in one place.
   */
  private buildToolFactoryContext(workspace: string): ToolFactoryContext {
    return {
      workspace,
      config: this.config,
      providerApiKeys: this.providerApiKeys,
      managedSkillsDir: this.managedSkillsDir,
      mcpManager: this.mcpManager,
      mcpConfigStore: this.mcpConfigStore,
      mcpAgentContext: this.mcpAgentContext,
      logger: this.logger,
      listSkills: () => this.listSkills(),
      onMcpToolsChanged: () => this.syncMcpToolsToSession(),
      allowedToolNames: resolveAllowedToolNames(this.config.tools),
    };
  }

  /**
   * Build the built-in PiAgent tools (pi-coding-agent shape).
   * These go in createAgentSession({ tools }) — PiAgent recognizes them by name.
   * Returns `any[]` because pi-coding-agent does not export its `Tool` type
   * from the package top-level; the registry stores them as `unknown`.
   */
  // biome-ignore lint/suspicious/noExplicitAny: pi-coding-agent does not export its Tool type
  private buildBuiltinTools(workspace: string): any[] {
    const ctx = this.buildToolFactoryContext(workspace);
    // biome-ignore lint/suspicious/noExplicitAny: same as above
    return this.toolRegistry.buildBuiltin(ctx) as any[];
  }

  /**
   * Build custom tools (task, skills, web, MCP).
   * These go in createAgentSession({ customTools }) — registered via the extension system.
   * AgentTool instances are wrapped as ToolDefinition (adds unused ctx parameter).
   */
  // biome-ignore lint/suspicious/noExplicitAny: pi-coding-agent's ToolDefinition is not exported
  private buildCustomTools(workspace: string = this.currentWorkspace): any[] {
    const ctx = this.buildToolFactoryContext(workspace);
    // biome-ignore lint/suspicious/noExplicitAny: same as above
    return this.toolRegistry.buildCustom(ctx) as any[];
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
    // Cache workspace so syncMcpToolsToSession() (which has no workspace
    // arg of its own) can rebuild custom tools with the same context the
    // session was started with.
    this.currentWorkspace = workspace;

    // Resolve credentials from the source (snapshot or provider function).
    const keys = await this.resolveProviderKeys();
    this.logger?.info(`[PiAgent] Starting with credentials: ${PiAgentBackend.redactKeys(keys)}`);

    this.auth = this.setupAuth();
    // Remember what we initialized auth with so `refreshCredentials()` can
    // detect real store mutations (vs. identical re-reads) and leave any
    // OAuth tokens pi refreshes in-memory alone.
    this.lastAppliedKeys = { ...keys };
    const model = this.resolveModel(this.config.model);

    // MCP: create manager if not injected and servers are configured
    if (!this.mcpManager && this.config.mcpServers?.length) {
      const { McpManager: McpMgr } = await import('@dash/mcp');
      this.mcpManager = new McpMgr(this.config.mcpServers, { logger: this.logger });
      await this.mcpManager.start();
      this.ownsMcpManager = true;
    }

    const builtinTools = this.buildBuiltinTools(workspace);
    const customTools = this.buildCustomTools(workspace);
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

    // Build the model chain: primary + operator-configured fallbacks.
    // Both come from `state`, which DashAgent rebuilds on every chat()
    // from a fresh registry read — so model + fallbackModels changes
    // made via `PUT /agents/:id` take effect on the next message
    // without a pool eviction. On failures that occur BEFORE any
    // event has been yielded, we transparently retry with the next
    // model. Once any output has been committed to the stream, errors
    // propagate normally — we can't safely retry mid-response.
    const modelChain = [state.model, ...(state.fallbackModels ?? [])];

    for (let attempt = 0; attempt < modelChain.length; attempt++) {
      const modelStr = modelChain[attempt];
      const isLastAttempt = attempt === modelChain.length - 1;

      // Resolve and switch to this attempt's model. A malformed model string
      // is a config error, not a runtime failure — but we still try the next
      // model in the chain rather than giving up immediately.
      let model: Model<Api>;
      try {
        model = this.resolveModel(modelStr);
      } catch (err) {
        const resolveError = err instanceof Error ? err : new Error(String(err));
        if (isLastAttempt) {
          yield { type: 'error', error: resolveError };
          return;
        }
        this.logger?.warn(
          `[PiAgent] Cannot resolve model "${modelStr}" (${resolveError.message}), falling back to "${modelChain[attempt + 1]}"`,
        );
        continue;
      }
      await this.session.setModel(model);

      // Update the resource loader with the current system prompt and skills,
      // then trigger a _baseSystemPrompt rebuild via setActiveToolsByName.
      // This ensures pi's session.prompt() uses the correct prompt instead of
      // overwriting Dash's prompt with its own _baseSystemPrompt. Only runs on
      // the first attempt — the resource loader state doesn't change across
      // retries (only the model does).
      if (attempt === 0 && this.resourceLoader) {
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
        pushEvent({
          type: '__error__',
          error: err instanceof Error ? err : new Error(String(err)),
        });
      });

      // Track whether we've yielded any normalized event. Once true, we can't
      // safely retry — retrying would duplicate or corrupt the output stream.
      let committed = false;
      let attemptError: Error | null = null;
      let completed = false;

      try {
        while (!completed) {
          if (options.signal?.aborted || this.abortRequested) {
            completed = true;
            break;
          }

          await waitForEvent();

          while (queue.length > 0) {
            const event = queue.shift();
            if (!event) break;

            if (event.type === '__done__') {
              completed = true;
              break;
            }

            if (event.type === '__error__') {
              attemptError = (event as { type: '__error__'; error: Error }).error;
              completed = true;
              break;
            }

            const normalized = this.normalizeEvent(event as AgentSessionEvent);
            if (normalized !== null) {
              yield normalized;
              committed = true;
            }
          }
        }
      } finally {
        unsubscribe();
        await promptPromise;
      }

      // Clean success (or clean abort): return without yielding further events
      if (!attemptError) return;

      // Error after content was emitted, or out of fallback options: propagate
      if (committed || isLastAttempt) {
        yield { type: 'error', error: attemptError };
        return;
      }

      // Safe to fall back — nothing has been yielded yet. Log and retry.
      this.logger?.warn(
        `[PiAgent] Model "${modelStr}" failed before output (${attemptError.message}), falling back to "${modelChain[attempt + 1]}"`,
      );
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

      case 'compaction_start': {
        const e = event as Extract<AgentSessionEvent, { type: 'compaction_start' }>;
        this.lastCompactionReason = e.reason === 'overflow' ? 'overflow' : 'threshold';
        return null;
      }

      case 'compaction_end': {
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
      sourceInfo: {
        path: s.location,
        source: s.source,
        scope: 'temporary' as const,
        origin: 'top-level' as const,
      },
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
