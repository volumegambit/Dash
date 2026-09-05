import type { MemoryType } from './memory/types.js';

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
      status: 'done' | 'failed' | 'cancelled';
      report: string;
      usage?: { inputTokens: number; outputTokens: number };
    }
  | { type: 'agent_retry'; attempt: number; reason: string }
  | { type: 'context_compacted'; overflow: boolean }
  | { type: 'question'; id: string; question: string; options: string[] }
  | { type: 'skill_loaded'; name: string }
  | { type: 'skill_created'; name: string; description: string }
  | {
      type: 'memory_saved';
      name: string;
      description: string;
      memoryType: MemoryType;
      action: 'created' | 'updated';
    }
  | { type: 'memory_forgotten'; name: string }
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
  /**
   * Per-agent automated memory. `dir` is the memory directory
   * (`<dataDir>/memory/<agentId>`); when set, DashAgent.chat() appends the
   * memory index + recalled memories to the system prompt every turn and the
   * backend registers save_memory / recall_memory / forget_memory unless
   * `tools === false` (swarm workers: read-only inheritance).
   */
  memory?: { dir: string; tools?: boolean };
  skills?: {
    paths?: string[];
    urls?: string[];
  };
  mcpServers?: import('@dash/mcp').McpServerConfig[];
  /** Names of MCP servers assigned to this agent from the gateway pool */
  assignedMcpServers?: string[];
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
