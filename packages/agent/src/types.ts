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
  workspace?: string;
  skills?: {
    paths?: string[];
    urls?: string[];
    /** Include the @dash/skills bundled library (default: true). */
    includeBundled?: boolean;
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

export interface AgentBackend {
  readonly name: string;
  start(workspace: string): Promise<void>;
  stop(): Promise<void>;
  run(state: AgentState, options: RunOptions): AsyncGenerator<AgentEvent>;
  abort(): void;
  answerQuestion?(id: string, answers: string[][]): Promise<void>;
  listSkills?(): Promise<import('./skills/types.js').SkillDiscoveryResult[]>;
}
