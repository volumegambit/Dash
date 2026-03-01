// --- Content block types for tool use ---

export interface TextBlock {
  type: 'text';
  text: string;
}

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

export interface RedactedThinkingBlock {
  type: 'redacted_thinking';
  data: string;
}

export type ContentBlock =
  | TextBlock
  | ToolUseBlock
  | ToolResultBlock
  | ThinkingBlock
  | RedactedThinkingBlock;

// --- Tool definitions ---

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

// --- Core types ---

export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string | ContentBlock[];
}

export interface CompletionRequest {
  model: string;
  messages: Message[];
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  stopSequences?: string[];
  tools?: ToolDefinition[];
  thinking?: { type: 'enabled'; budgetTokens: number };
}

export interface CompletionResponse {
  content: string | ContentBlock[];
  model: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
  stopReason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use';
}

export interface StreamChunk {
  type:
    | 'text_delta'
    | 'tool_use_start'
    | 'tool_use_delta'
    | 'thinking_delta'
    | 'thinking_stop'
    | 'stop';
  text?: string;
  thinking?: string;
  signature?: string;
  toolUse?: { id: string; name: string };
  toolUseDelta?: { partial_json: string };
  stopReason?: CompletionResponse['stopReason'];
}

export interface LlmProvider {
  readonly name: string;
  complete(request: CompletionRequest): Promise<CompletionResponse>;
  stream(request: CompletionRequest): AsyncGenerator<StreamChunk, CompletionResponse>;
}
