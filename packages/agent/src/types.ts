// --- LLM provider types (formerly from @dash/llm) ---

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
  signature: string;
}

export interface ImageBlock {
  type: 'image';
  mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  data: string; // base64-encoded
}

// --- Agent types ---

export type SubagentTerminalStatus = 'done' | 'failed' | 'cancelled' | 'interrupted' | 'max_turns';

export type AgentEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_use_start'; id: string; name: string; input?: Record<string, unknown> }
  | { type: 'tool_use_delta'; partial_json: string }
  | {
      type: 'tool_result';
      id: string;
      name: string;
      content: string;
      isError?: boolean;
      details?: unknown;
    }
  | {
      type: 'response';
      content: string;
      usage: {
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens?: number;
        cacheWriteTokens?: number;
      };
    }
  | { type: 'error'; error: Error; timestamp?: string }
  | { type: 'file_changed'; files: string[] }
  | { type: 'agent_spawned'; name: string }
  | {
      type: 'worker_spawned';
      workerId: string;
      runId: string;
      role: string;
      brief: string;
      model: string;
    }
  | {
      type: 'worker_status';
      workerId: string;
      runId: string;
      role: string;
      status: 'running' | 'waiting_input';
      detail?: string;
      question?: string;
    }
  | {
      type: 'worker_done';
      workerId: string;
      runId: string;
      role: string;
      status: 'done' | 'failed' | 'cancelled' | 'interrupted' | 'max_turns';
      report: string;
      usage?: { inputTokens: number; outputTokens: number };
    }
  | {
      type: 'subagent_started';
      subagentId: string;
      name?: string;
      subagentType: string;
      description: string;
      prompt: string;
      model: string;
      background: boolean;
      depth: number;
      startedAt: string;
      isolation?: 'worktree';
      parentTurnId?: string;
    }
  | {
      type: 'subagent_progress';
      subagentId: string;
      status: 'running' | 'waiting_input';
      toolCallCount: number;
      elapsedMs: number;
      detail?: string;
      question?: string;
    }
  | {
      type: 'subagent_finished';
      subagentId: string;
      name?: string;
      subagentType: string;
      description: string;
      status: SubagentTerminalStatus;
      report: string;
      usage?: { inputTokens: number; outputTokens: number };
      toolCallCount: number;
      startedAt: string;
      endedAt: string;
    }
  | { type: 'agent_retry'; attempt: number; reason: string }
  | { type: 'context_compacted'; overflow: boolean }
  | { type: 'question'; id: string; question: string; options: string[] }
  | { type: 'skill_loaded'; name: string }
  | { type: 'skill_created'; name: string; description: string }
  | { type: 'mcp_server_error'; server: string; error: string };

export interface DashAgentConfig {
  model: string;
  fallbackModels?: string[];
  systemPrompt: string;
  tools?: string[];
  /**
   * Provider allow-list gating model resolution. `undefined` = no gating (any
   * provider); `[]` = no provider allowed; otherwise the `provider/` segment of
   * every resolved model (primary AND fallback) must be a member. Enforced in
   * `resolveModelString` before catalog/pi-ai lookup, so a disallowed provider
   * fails with a distinct policy error rather than "Unknown model".
   */
  allowedProviders?: string[];
  workspace?: string;
  skills?: {
    paths?: string[];
    urls?: string[];
  };
  mcpServers?: import('@dash/mcp').McpServerConfig[];
  /** Names of MCP servers assigned to this agent from the gateway pool */
  assignedMcpServers?: string[];
  /**
   * Exact `server__tool` names this agent may call, applied AFTER the
   * `assignedMcpServers` filter. `undefined` = no per-tool narrowing (every
   * tool of every assigned server); `[]` = no MCP tool at all.
   *
   * Because it is an intersection applied after the server gate, naming a tool
   * from an unassigned server grants nothing — it cannot widen the grant, only
   * narrow it. Used for spawned sub-agents, whose definition may grant
   * `github__pr` without also handing over `github__merge`.
   */
  mcpToolAllowlist?: string[];
  /**
   * Memory-preamble policy. Omitted (or `enabled` left unset) keeps the
   * default: whenever `workspace` is set, the workspace MEMORY.md preamble is
   * appended to the system prompt. `{ enabled: false }` opts out entirely —
   * used for turn-scoped subagents (Explore / Plan) whose findings belong in
   * the report they hand their parent, not in a memory file.
   *
   * `readOnly: true` keeps the memory BODY in the preamble but drops every
   * instruction to update the file. Set for spawned sub-agents: several run
   * concurrently on one workspace, and the default preamble's `write_file`
   * advice is a whole-file overwrite — a lost-update hazard on a user-visible
   * artifact. See `MemoryPreambleOptions.readOnly`.
   */
  memory?: { enabled?: boolean; readOnly?: boolean };
}

export interface AgentState {
  channelId: string;
  conversationId: string;
  message: string;
  systemPrompt: string;
  model: string;
  fallbackModels?: string[];
  /**
   * Provider allow-list gating model resolution for THIS message. Carried on
   * `AgentState` — rebuilt from the live config on every `chat()` — so the gate
   * rides the exact same per-message mechanism as `model`/`fallbackModels`: a
   * warm backend picks up allow-list changes on the next turn without a pool
   * eviction, and the gate can never come from a different config generation
   * than the model string it guards. `undefined` = no gating; `[]` = no provider
   * allowed. See `DashAgentConfig.allowedProviders`.
   */
  allowedProviders?: string[];
  tools?: string[];
  workspace?: string;
  images?: ImageBlock[];
}

export interface RunOptions {
  signal?: AbortSignal;
}

/**
 * Structurally-typed agent tool injected into the backend at construction
 * (e.g. the projects_* tools from @dash/projects). Kept loose so @dash/agent
 * has no dependency on @dash/projects or the pi SDK. Matches the AgentTool
 * shape PiAgent duck-types.
 */
export interface ExtraTool {
  name: string;
  label: string;
  description: string;
  // biome-ignore lint/suspicious/noExplicitAny: TypeBox schema shape varies per tool
  parameters: any;
  execute: (
    toolCallId: string,
    // biome-ignore lint/suspicious/noExplicitAny: per-tool param types are not statically known
    params: any,
    signal?: AbortSignal,
    onUpdate?: unknown,
  ) => Promise<{ content: Array<{ type: 'text'; text: string }>; details: unknown }>;
}

/**
 * Structurally-typed plugin hook runner injected into the backend at
 * construction (the `createHookEngine` result from @dash/plugins). Duck-typed
 * so @dash/agent has NO dependency on @dash/plugins — same pattern as
 * `ExtraTool`. The field names mirror the engine's input/decision shapes
 * exactly (toolName, toolInput, toolResponse, sessionId, cwd, source) so the
 * concrete engine satisfies this interface without an adapter.
 *
 * Only the methods the backend actually calls are listed. `runUserPromptSubmit`
 * is wired in the router, not here.
 *
 * Note: PreToolUse's `updatedInput` cannot be applied through pi's
 * `beforeToolCall` (pi's `BeforeToolCallResult` only carries `block`/`reason`),
 * so the backend uses PreToolUse for allow/deny only. The field is part of the
 * interface for parity with the engine but is ignored by the backend.
 */
export interface HookRunner {
  runPreToolUse(input: {
    toolName: string;
    toolInput: unknown;
    sessionId?: string;
    cwd?: string;
  }): Promise<{ block: boolean; reason?: string; updatedInput?: unknown }>;
  runPostToolUse(input: {
    toolName: string;
    toolInput: unknown;
    toolResponse: string;
    sessionId?: string;
    cwd?: string;
  }): Promise<{ block: boolean; reason?: string; additionalContext?: string }>;
  runSessionStart(input: {
    sessionId?: string;
    cwd?: string;
    source?: string;
  }): Promise<{ additionalContext?: string }>;
  runStop(input: {
    sessionId?: string;
    cwd?: string;
    source?: string;
  }): Promise<{ additionalContext?: string }>;
  /** True when any hooks are registered — lets the backend skip wiring entirely. */
  readonly hasHooks: boolean;
}

/**
 * Structurally-typed catalog of plugin-contributed LLM models, injected into
 * the backend at construction. Duck-typed so @dash/agent has NO dependency on
 * @dash/plugins — the gateway builds the concrete catalog (Task 3) and the
 * agent only calls `resolve`.
 *
 * `resolve` is consulted by `resolveModel` ONLY as a fallback: when the static
 * pi-ai registry does not know a `provider/modelId`. It returns a pi-ai
 * `Model<Api>`-shaped object (typed `unknown` here to keep this interface free
 * of a pi-ai type leak; the backend casts the result) or `null` when the
 * catalog doesn't recognize the model either.
 */
export interface PluginModelCatalog {
  /**
   * Returns the resolved pi-ai `Model<Api>`-shaped object, or `null` when the
   * catalog doesn't recognize the model. (`unknown` already subsumes `null`, so
   * the return type is plain `unknown`; the null = not-found contract lives in
   * this comment and the interface doc above.)
   */
  resolve(provider: string, modelId: string): unknown;
}

export interface AgentBackend {
  readonly name: string;
  start(workspace: string): Promise<void>;
  stop(): Promise<void>;
  run(state: AgentState, options: RunOptions): AsyncGenerator<AgentEvent>;
  abort(): void;
  answerQuestion?(id: string, answers: string[][]): Promise<void>;
  listSkills?(): Promise<import('./skills/types.js').SkillDiscoveryResult[]>;
}

/**
 * Every `PiAgentBackend` construction input as a NAMED slot.
 *
 * The positional constructor takes twelve arguments, eight of them optional —
 * a caller that wants only the last one has to spell out a run of `undefined`s,
 * and the meaning of each slot lives in its position rather than its name. That
 * is exactly how the gateway's stripped worker backend ended up silently
 * shipping `undefined` for the MCP, skills and hook slots. `fromOptions`
 * consumes this shape; the positional form stays for its existing callers.
 *
 * The MCP / logger / skill-file types are referenced through inline `import()`
 * types so this module keeps its zero top-level imports and @dash/agent gains
 * no new runtime dependency edge.
 */
export interface PiAgentBackendOptions {
  config: DashAgentConfig;
  providerApiKeysSource: import('./backends/piagent.js').ProviderApiKeysSource;
  logger?: import('./logger.js').Logger;
  sessionDir?: string;
  /** Writable managed-skills dir. Grants create_skill/install_skill/remove_skill. */
  managedSkillsDir?: string;
  mcpManager?: import('@dash/mcp').McpManager;
  mcpConfigStore?: import('@dash/mcp').McpConfigStoreInterface;
  mcpAgentContext?: import('@dash/mcp').McpAgentContext;
  extraTools?: ExtraTool[];
  extraSkillFiles?: import('./skills/index.js').FlatSkillFile[];
  hookRunner?: HookRunner;
  pluginModelCatalog?: PluginModelCatalog;
}
