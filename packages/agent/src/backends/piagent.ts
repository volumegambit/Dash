import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AgentEvent as PiAgentEvent } from '@earendil-works/pi-agent-core';
import { getModel } from '@earendil-works/pi-ai';
import type { Api, AssistantMessage, ImageContent, Model, Usage } from '@earendil-works/pi-ai';
import {
  AuthStorage,
  DefaultResourceLoader,
  SessionManager,
  createAgentSession,
} from '@earendil-works/pi-coding-agent';
import type { AgentSession, AgentSessionEvent, Skill } from '@earendil-works/pi-coding-agent';

import type { McpAgentContext, McpConfigStoreInterface, McpManager } from '@dash/mcp';
import {
  createMcpAddServerTool,
  createMcpListServersTool,
  createMcpRemoveServerTool,
} from '@dash/mcp';

import type { Logger } from '../logger.js';
import {
  createCreateSkillTool,
  createInstallSkillTool,
  createLoadSkillTool,
  createRemoveSkillTool,
  discoverSkills,
  heuristicScan,
  loadFlatSkills,
} from '../skills/index.js';
import type { FlatSkillFile, SkillSecurityScanner } from '../skills/index.js';
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
  ExtraTool,
  HookRunner,
  PluginModelCatalog,
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
 * Stringify a pi tool result for the PostToolUse `toolResponse` payload.
 * Prefers the joined text content blocks (what the model actually sees); falls
 * back to a JSON dump of the whole result.
 */
function stringifyToolResult(result: unknown): string {
  if (
    result &&
    typeof result === 'object' &&
    Array.isArray((result as { content?: unknown }).content)
  ) {
    const content = (result as { content: Array<{ type?: string; text?: string }> }).content;
    const text = content
      .filter((c) => c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text as string)
      .join('\n');
    if (text) return text;
  }
  try {
    return JSON.stringify(result ?? '');
  } catch {
    return String(result ?? '');
  }
}

/**
 * Compose plugin tool hooks onto a live pi `Agent`, preserving pi's own
 * handlers. pi installs its OWN `beforeToolCall`/`afterToolCall` in the
 * AgentSession ctor, so this MUST run AFTER `createAgentSession(...)` returns —
 * it saves pi's prior handler, then sets a wrapper that awaits the prior one
 * first and composes the plugin decision around it.
 *
 * Exported for unit testing with a fake agent + fake HookRunner.
 *
 * Composition rules:
 * - beforeToolCall: await pi's prior handler; if it blocks, return its block
 *   verbatim (pi wins, plugin pre-hook is skipped). Otherwise run the plugin
 *   PreToolUse hook; if it blocks, return `{ block: true, reason }`. Else return
 *   pi's prior result unchanged.
 * - afterToolCall: await pi's prior handler (its override, if any, becomes the
 *   working result). Run the plugin PostToolUse hook; if it blocks, set
 *   `isError` and append the block reason to the content; if it returns
 *   `additionalContext`, append it as a text block. Omitted fields keep pi's /
 *   the executed result's values (pi's field-by-field merge semantics).
 *
 * Limitation: pi's `BeforeToolCallResult` only carries `block`/`reason` — there
 * is NO supported way to feed modified args back into the tool call. So
 * PreToolUse is allow/deny only here; the engine's `updatedInput` cannot be
 * applied. It is NOT silently dropped: the wrapper logs a one-time warning so an
 * operator who installs a Claude-Code arg-rewriting hook learns it has no effect
 * (and should use `permissionDecision: "deny"` to block instead).
 */
export function composeToolHooks(
  // biome-ignore lint/suspicious/noExplicitAny: pi Agent's hook fields are not exported as a usable type
  agent: any,
  hookRunner: HookRunner,
  ctxInfo: { sessionId?: string | (() => string | undefined); cwd?: string; logger?: Logger },
): void {
  const { cwd, logger } = ctxInfo;
  // Warn at most once per install when a hook returns un-appliable updatedInput.
  let warnedUpdatedInput = false;
  // sessionId may be a static value (tests) or a thunk read at fire-time, so
  // the per-run conversation id is current when each hook fires.
  const resolveSessionId = (): string | undefined =>
    typeof ctxInfo.sessionId === 'function' ? ctxInfo.sessionId() : ctxInfo.sessionId;

  // biome-ignore lint/suspicious/noExplicitAny: pi BeforeToolCall context/result types are not exported
  const priorBefore: ((ctx: any, signal?: AbortSignal) => Promise<any>) | undefined =
    agent.beforeToolCall;
  // biome-ignore lint/suspicious/noExplicitAny: pi BeforeToolCall context/result types are not exported
  agent.beforeToolCall = async (ctx: any, signal?: AbortSignal) => {
    const piRes = await priorBefore?.(ctx, signal);
    // pi's prior block wins — skip the plugin pre-hook entirely.
    if (piRes?.block) return piRes;

    // The HookRunner is duck-typed (the createHookEngine result from
    // @dash/plugins). The engine never throws, but defend the composition
    // anyway: a throwing runner must not break the tool call. Fail open —
    // allow, returning pi's prior result.
    let decision: Awaited<ReturnType<HookRunner['runPreToolUse']>>;
    try {
      // Tool name lives at ctx.toolCall.name (pi-ai ToolCall.name), NOT toolName.
      decision = await hookRunner.runPreToolUse({
        toolName: ctx?.toolCall?.name,
        toolInput: ctx?.args,
        sessionId: resolveSessionId(),
        cwd,
      });
    } catch {
      return piRes;
    }
    if (decision.block) {
      return { block: true, reason: decision.reason };
    }
    // The engine may return `updatedInput` (a hook rewrote the tool args), but
    // pi's BeforeToolCallResult is allow/deny only — there is no supported way
    // to feed modified args back into the call. Warn ONCE rather than silently
    // no-op, so an operator who installs an arg-rewriting hook learns it has no
    // effect on this backend.
    if (decision.updatedInput !== undefined && !warnedUpdatedInput) {
      warnedUpdatedInput = true;
      const message = `[PiAgent] a PreToolUse hook returned updatedInput for tool '${ctx?.toolCall?.name}', but this backend cannot apply modified tool arguments — the tool runs with the original input. Use permissionDecision: "deny" to block a call instead.`;
      // Fall back to console.warn when no structured logger is injected (the
      // gateway constructs the backend without one) so the warning is never
      // silently swallowed.
      if (logger) logger.warn(message);
      else console.warn(message);
    }
    return piRes;
  };

  // biome-ignore lint/suspicious/noExplicitAny: pi AfterToolCall context/result types are not exported
  const priorAfter: ((ctx: any, signal?: AbortSignal) => Promise<any>) | undefined =
    agent.afterToolCall;
  // biome-ignore lint/suspicious/noExplicitAny: pi AfterToolCall context/result types are not exported
  agent.afterToolCall = async (ctx: any, signal?: AbortSignal) => {
    const piRes = await priorAfter?.(ctx, signal);

    // Defend the composition against a throwing (duck-typed) HookRunner: a
    // throw here must not break the tool result. Fail open — return the
    // prior/base result unchanged so the plugin simply contributes nothing.
    let decision: Awaited<ReturnType<HookRunner['runPostToolUse']>>;
    try {
      decision = await hookRunner.runPostToolUse({
        toolName: ctx?.toolCall?.name,
        toolInput: ctx?.args,
        toolResponse: stringifyToolResult(ctx?.result),
        sessionId: resolveSessionId(),
        cwd,
      });
    } catch {
      return piRes;
    }

    // Working content/isError: pi's override (if any) layered over the executed
    // result. Clone the content array so we never mutate pi's internal state.
    const baseContent: Array<{ type: string; text?: string }> = Array.isArray(piRes?.content)
      ? piRes.content
      : Array.isArray(ctx?.result?.content)
        ? ctx.result.content
        : [];
    const content = [...baseContent];
    // When there's no prior after-handler (piRes undefined), fall back to the
    // executed result's error flag so a plugin contribution doesn't silently
    // drop the tool's own isError.
    let isError: boolean | undefined = piRes?.isError ?? ctx?.result?.isError;

    if (decision.block) {
      isError = true;
      content.push({ type: 'text', text: decision.reason ?? 'Tool blocked by plugin hook' });
    }
    if (decision.additionalContext) {
      content.push({ type: 'text', text: decision.additionalContext });
    }

    // Nothing for the plugin to contribute: return pi's prior result untouched.
    if (!decision.block && !decision.additionalContext) {
      return piRes;
    }

    return {
      ...(piRes ?? {}),
      content,
      ...(isError !== undefined ? { isError } : {}),
    };
  };
}

/**
 * PiAgentBackend - AgentBackend implementation using the PiAgent SDK
 * (@earendil-works/pi-coding-agent).
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
  /** Workspace cwd captured in start(); used as the hook cwd in run(). */
  private workspace: string | null = null;
  private ownsMcpManager = false;
  private resourceLoader: DashResourceLoader | null = null;

  /** Tools injected by the host (e.g. projects_* from @dash/projects). */
  private extraTools: ExtraTool[] = [];

  /**
   * Flat single-file skill/command entries (Claude Code `commands/*.md`) injected
   * by the host (e.g. the gateway plugin loader's `commandFiles`). Each entry
   * carries an optional `namespace` so plugin commands register as the namespaced
   * skill `<plugin>:<command>`. Loaded via `loadFlatSkills()` and merged into
   * `listSkills()` after discovered skills.
   */
  private extraSkillFiles: FlatSkillFile[] = [];

  /**
   * Conversation id of the in-flight run, exposed to injected tools via
   * getCurrentSessionId(). Set at the top of run(); null when idle. This is
   * the session_id used for session_issue_link upserts.
   */
  private currentSessionId: string | null = null;

  /** Accumulated full text during a response, for the `response` event */
  private fullText = '';

  /** Track the compaction reason from auto_compaction_start for use in auto_compaction_end */
  private lastCompactionReason: 'threshold' | 'overflow' = 'threshold';

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

  constructor(
    private config: DashAgentConfig,
    private providerApiKeysSource: ProviderApiKeysSource,
    private logger?: Logger,
    private sessionDir?: string,
    private managedSkillsDir?: string,
    private mcpManager?: McpManager,
    private mcpConfigStore?: McpConfigStoreInterface,
    private mcpAgentContext?: McpAgentContext,
    extraTools: ExtraTool[] = [],
    extraSkillFiles: FlatSkillFile[] = [],
    /**
     * Optional plugin hook runner (the `createHookEngine` result from
     * @dash/plugins, duck-typed). When present and `hasHooks` is true, tool
     * hooks are composed onto the pi agent and SessionStart/Stop fire around
     * each run. Zero overhead when undefined.
     */
    private hookRunner?: HookRunner,
    /**
     * Optional catalog of plugin-contributed LLM models (built by the gateway,
     * duck-typed via `PluginModelCatalog`). Consulted by `resolveModel` ONLY as
     * a fallback when the static pi-ai registry doesn't know a provider/model.
     * Zero behavior change when undefined.
     */
    private pluginModelCatalog?: PluginModelCatalog,
  ) {
    this.extraTools = extraTools;
    this.extraSkillFiles = extraSkillFiles;
  }

  /** Current conversation/session id for the in-flight run, or null when idle. */
  getCurrentSessionId(): string | null {
    return this.currentSessionId;
  }

  /** Test/host hook to set the current session id outside run(). */
  setCurrentSessionId(sessionId: string | null): void {
    this.currentSessionId = sessionId;
  }

  /** Names of injected extra tools (for diagnostics/tests). */
  listExtraToolNames(): string[] {
    return this.extraTools.map((t) => t.name);
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
    // Static pi-ai registry wins. Only when it doesn't know the model do we
    // fall back to a plugin-contributed catalog (if one was injected).
    if (model) return model;
    if (this.pluginModelCatalog) {
      const m = this.pluginModelCatalog.resolve(provider, modelId);
      if (m) return m as Model<Api>;
    }
    throw new Error(
      `Unknown model "${modelStr}". Check that the provider and model ID are correct.`,
    );
  }

  /**
   * The built-in file-tool names this agent should have active, filtered by the
   * config's tool allowlist.
   *
   * pi (@earendil-works/pi-coding-agent) creates the built-in tools itself,
   * scoped to the session `cwd`, from `createAllToolDefinitions(cwd)` — we just
   * name which ones to activate. (In older pi we passed the tool *objects* via
   * `createAgentSession({ tools })`; that option is now a name allowlist, so we
   * activate by name via `setActiveToolsByName` instead — see start().)
   */
  private allowedBuiltinToolNames(): string[] {
    const allowedNames = this.config.tools
      ? new Set(this.config.tools)
      : new Set<string>(DEFAULT_TOOL_NAMES);
    return DEFAULT_TOOL_NAMES.filter((name) => allowedNames.has(name));
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

    // Skill install/remove from the public ecosystem (opt-in)
    if (allowedNames.has('install_skill') && this.managedSkillsDir) {
      customs.push(
        wrap(
          createInstallSkillTool(this.managedSkillsDir, this.skillScanner(), () =>
            this.refreshSkills(),
          ),
        ),
      );
    }
    if (allowedNames.has('remove_skill') && this.managedSkillsDir) {
      customs.push(
        wrap(
          createRemoveSkillTool(
            this.managedSkillsDir,
            () => this.listSkills(),
            () => this.refreshSkills(),
          ),
        ),
      );
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

    // Host-injected tools (e.g. projects_* from @dash/projects). Wrapped
    // identically to the other custom tools so PiAgent's ctx parameter is
    // tolerated.
    for (const tool of this.extraTools) {
      customs.push(wrap(tool));
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
    this.workspace = workspace;
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

    const builtinToolNames = this.allowedBuiltinToolNames();
    const customTools = this.buildCustomTools();
    this.logger?.info(
      `[PiAgent] Activating ${builtinToolNames.length} built-in tools: ${builtinToolNames.join(', ')}`,
    );
    this.logger?.info(
      `[PiAgent] Registering ${customTools.length} custom tools: ${customTools.map((t: { name: string }) => t.name).join(', ')}`,
    );

    // Isolate pi's config/state (settings.json, models.json) under a Dash-owned
    // directory instead of the user's ~/.pi/agent, so the operator's personal
    // pi CLI settings never leak into deployed agents. Required by the resource
    // loader; also steers the session's default SettingsManager/ModelRegistry.
    // The dir need not exist — pi falls back to defaults for anything missing.
    const agentDir = join(tmpdir(), 'dash-pi-agent');

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
      agentDir,
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
      agentDir,
      cwd: workspace,
      authStorage: this.auth,
      model,
      // Preserve Dash's prior behavior: thinking off by default. (The new pi
      // SDK defaults to 'medium'; Dash has historically run every model with
      // thinking off. Opus 4.8 / Fable 5 still resolve and run correctly — the
      // new pi-ai omits/uses adaptive thinking for them rather than 400-ing.)
      thinkingLevel: 'off',
      customTools,
      resourceLoader: this.resourceLoader,
      sessionManager: this.sessionDir
        ? SessionManager.continueRecent(workspace, this.sessionDir)
        : SessionManager.inMemory(),
    });

    this.session = session;

    // Compose plugin tool hooks onto pi's agent. MUST run AFTER
    // createAgentSession(...) returns — pi installs its own beforeToolCall/
    // afterToolCall in the session ctor, and composeToolHooks saves+wraps them.
    // This covers built-in + custom + MCP tools. Zero overhead when there's no
    // runner or no hooks registered. sessionId is read at fire-time (it's the
    // per-run conversation id); cwd is the static workspace.
    if (this.hookRunner?.hasHooks) {
      composeToolHooks((session as unknown as { agent: unknown }).agent, this.hookRunner, {
        sessionId: () => this.currentSessionId ?? undefined,
        cwd: workspace,
        logger: this.logger,
      });
    }

    // pi creates the built-in file tools (read/bash/edit/write/grep/find/ls)
    // scoped to `cwd`, but only read/bash/edit/write are active by default.
    // Activate exactly Dash's set — allowed built-ins plus all custom tools —
    // by name. We intentionally do NOT pass a `tools` allowlist to
    // createAgentSession: that becomes a global filter that would also drop
    // MCP tools added dynamically at runtime. Unknown names here are ignored.
    this.session.setActiveToolsByName([
      ...builtinToolNames,
      ...customTools.map((t: { name: string }) => t.name),
    ]);
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
    this.currentSessionId = state.conversationId;

    const hookCwd = state.workspace ?? this.workspace ?? undefined;

    try {
      // Fire the SessionStart lifecycle hook (plugins) before the model runs.
      // Its additionalContext is appended to pi's system prompt via the resource
      // loader; setActiveToolsByName() inside runModelChain forces a rebuild so
      // the appended sections take effect on this run. No-op when no runner.
      if (this.hookRunner?.hasHooks) {
        const start = await this.hookRunner.runSessionStart({
          sessionId: state.conversationId,
          cwd: hookCwd,
          source: 'startup',
        });
        // Reset the append slot every run so a prior run's SessionStart context
        // can't leak into a later run that returns none. setAppendSystemPrompt
        // has no co-tenant — the memory preamble is folded into systemPrompt in
        // DashAgent.chat() (a different slot), so a plain reset is safe.
        if (this.resourceLoader) {
          this.resourceLoader.setAppendSystemPrompt(
            start.additionalContext ? [start.additionalContext] : [],
          );
        }
      }

      yield* this.runModelChain(state, options);
    } finally {
      // Fire the Stop lifecycle hook (plugins). Stop's additionalContext has
      // nowhere to go after the run completes (the turn is over), so we log it
      // and otherwise ignore it. No-op when no runner.
      if (this.hookRunner?.hasHooks) {
        try {
          const stop = await this.hookRunner.runStop({
            sessionId: state.conversationId,
            cwd: hookCwd,
          });
          if (stop.additionalContext) {
            this.logger?.info(
              `[PiAgent] Stop hook additionalContext ignored (run already complete): ${stop.additionalContext.slice(0, 200)}`,
            );
          }
        } catch (err) {
          this.logger?.warn(
            `[PiAgent] Stop hook failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      // Clear the in-flight session id so consumers calling getCurrentSessionId()
      // during async teardown after run() returns don't observe a stale id. Only
      // resets the field — does not affect the generator's return/throw semantics.
      this.currentSessionId = null;
    }
  }

  /**
   * Drive the model chain (primary + fallbacks) for a single run. Extracted from
   * run() so run() can wrap it in a try/finally that resets currentSessionId
   * without re-indenting the whole body.
   */
  private async *runModelChain(state: AgentState, options: RunOptions): AsyncGenerator<AgentEvent> {
    if (!this.session) {
      throw new Error('PiAgentBackend not started. Call start() first.');
    }

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
   * Build the skill security scanner used by install_skill. v1 uses the
   * deterministic heuristic prefilter; an LLM classifier can be layered in via
   * createLlmScanner once a one-shot model call is wired.
   */
  private skillScanner(): SkillSecurityScanner {
    return async (content: string) => heuristicScan(content);
  }

  /** Re-inject the current skill set into the live session's system prompt. */
  private async refreshSkills(): Promise<void> {
    if (!this.resourceLoader) return;
    this.resourceLoader.setExtraSkills(await this.listSkillsAsPiSkills());
  }

  /**
   * Discover skills across all tiers (managed > configured paths > bundled),
   * then merge in any flat single-file skills/commands supplied via
   * `extraSkillFiles`. Discovered skills win on a name collision — flat skills
   * whose name already appears are skipped.
   */
  async listSkills(): Promise<SkillDiscoveryResult[]> {
    const discovered = await discoverSkills({
      managedSkillsDir: this.managedSkillsDir,
      paths: this.config.skills?.paths,
      includeBundled: this.config.skills?.includeBundled,
    });
    const flat = await loadFlatSkills(this.extraSkillFiles);
    const seen = new Set(discovered.map((s) => s.name));
    return [...discovered, ...flat.filter((s) => !seen.has(s.name))];
  }
}
