import type { CompletionResponse, ContentBlock, Message, ToolDefinition } from '@dash/llm';

export interface SessionEntry {
  timestamp: string;
  type: 'message' | 'response' | 'tool_call' | 'tool_result' | 'error';
  data: Record<string, unknown>;
}

export interface Session {
  id: string;
  channelId: string;
  conversationId: string;
  createdAt: string;
  messages: Message[];
}

// --- Tool interfaces ---

export interface ToolExecutionResult {
  content: string;
  isError?: boolean;
}

export interface Tool {
  name: string;
  definition: ToolDefinition;
  execute(input: Record<string, unknown>): Promise<ToolExecutionResult>;
}

export interface DashAgentConfig {
  model: string;
  systemPrompt: string;
  tools?: Tool[];
  maxTokens?: number;
  thinking?: { budgetTokens: number };
}

// --- Agent state ---

export interface AgentState {
  session: Session;
  systemPrompt: string;
  model: string;
  tools?: Tool[];
  maxTokens?: number;
  thinking?: { budgetTokens: number };
}

export interface RunOptions {
  signal?: AbortSignal;
  onChunk?: (text: string) => void;
}

export type AgentEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_use_start'; id: string; name: string }
  | { type: 'tool_use_delta'; partial_json: string }
  | { type: 'tool_result'; id: string; name: string; content: string; isError?: boolean }
  | { type: 'response'; content: string; usage: CompletionResponse['usage'] }
  | { type: 'error'; error: Error };

export interface AgentBackend {
  readonly name: string;
  run(state: AgentState, options: RunOptions): AsyncGenerator<AgentEvent>;
  abort(): void;
}

export interface SessionStore {
  load(channelId: string, conversationId: string): Promise<Session | null>;
  save(session: Session): Promise<void>;
  append(sessionId: string, entry: SessionEntry): Promise<void>;
}
