export type AgentEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_use_start'; id: string; name: string }
  | { type: 'tool_use_delta'; partial_json: string }
  | { type: 'tool_result'; id: string; name: string; content: string; isError?: boolean }
  | { type: 'response'; content: string; usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number } }
  | { type: 'error'; error: Error }
  | { type: 'file_changed'; files: string[] }
  | { type: 'agent_spawned'; name: string }
  | { type: 'agent_retry'; attempt: number; reason: string }
  | { type: 'context_compacted'; overflow: boolean }
  | { type: 'question'; id: string; question: string; options: string[] };

export interface DashAgentConfig {
  model: string;      // "provider/model-id", e.g. "anthropic/claude-opus-4-5"
  systemPrompt: string;
  tools?: string[];   // OpenCode tool names
  workspace?: string;
}

export interface AgentState {
  channelId: string;
  conversationId: string;
  message: string;
  systemPrompt: string;
  model: string;
  tools?: string[];
  workspace?: string;
}

export interface RunOptions {
  signal?: AbortSignal;
}

export interface AgentBackend {
  readonly name: string;
  run(state: AgentState, options: RunOptions): AsyncGenerator<AgentEvent>;
  abort(): void;
  answerQuestion?(id: string, answers: string[][]): Promise<void>;
}
