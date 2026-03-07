import OpenAI from 'openai';
import type {
  CompletionRequest,
  CompletionResponse,
  ContentBlock,
  LlmProvider,
  Message,
  StreamChunk,
  ThinkingBlock,
  ToolUseBlock,
} from '../types.js';

/** Returns true for reasoning models (o1, o3, o4 families) */
function isReasoningModel(model: string): boolean {
  return model.startsWith('o1') || model.startsWith('o3') || model.startsWith('o4');
}

/** Map Dash Message[] to Responses API input items */
function toInputItems(messages: Message[]): Record<string, unknown>[] {
  const items: Record<string, unknown>[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') continue;

    if (typeof msg.content === 'string') {
      if (msg.role === 'assistant') {
        items.push({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: msg.content }],
        });
      } else {
        items.push({ role: 'user', content: msg.content });
      }
      continue;
    }

    // ContentBlock[] — collect assistant text, emit tool blocks individually
    const textParts: string[] = [];

    for (const block of msg.content) {
      if (block.type === 'text') {
        textParts.push(block.text);
      } else if (block.type === 'tool_use') {
        // Flush accumulated text before the function call
        if (textParts.length > 0 && msg.role === 'assistant') {
          items.push({
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: textParts.join('') }],
          });
          textParts.length = 0;
        }
        items.push({
          type: 'function_call',
          id: block.id,
          call_id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input),
        });
      } else if (block.type === 'tool_result') {
        items.push({
          type: 'function_call_output',
          call_id: block.tool_use_id,
          output: block.content,
        });
      }
      // Skip 'thinking' and 'redacted_thinking' blocks (Anthropic-specific)
    }

    // Flush remaining text
    if (textParts.length > 0) {
      if (msg.role === 'assistant') {
        items.push({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: textParts.join('') }],
        });
      } else {
        items.push({ role: 'user', content: textParts.join('') });
      }
    }
  }

  return items;
}

/** Map response status to our stop reason */
function mapStopReason(
  status: string,
  hasFunctionCalls: boolean,
): CompletionResponse['stopReason'] {
  if (hasFunctionCalls) return 'tool_use';
  if (status === 'incomplete') return 'max_tokens';
  return 'end_turn';
}

/** Extract content from Responses API output items */
function fromOutputItems(
  output: Record<string, unknown>[],
): { content: string | ContentBlock[]; hasFunctionCalls: boolean } {
  const hasFunctionCalls = output.some((item) => item.type === 'function_call');
  const hasReasoning = output.some((item) => item.type === 'reasoning');

  if (!hasFunctionCalls && !hasReasoning) {
    const text = output
      .filter((item) => item.type === 'message')
      .flatMap((item) => (item.content as Record<string, unknown>[]) ?? [])
      .filter((c) => c.type === 'output_text')
      .map((c) => c.text as string)
      .join('');
    return { content: text, hasFunctionCalls: false };
  }

  const blocks: ContentBlock[] = [];

  for (const item of output) {
    if (item.type === 'reasoning') {
      const summaries = (item.summary as Record<string, unknown>[]) ?? [];
      for (const summary of summaries) {
        if (summary.type === 'summary_text') {
          blocks.push({
            type: 'thinking',
            thinking: summary.text as string,
            signature: '',
          });
        }
      }
    } else if (item.type === 'message') {
      const contents = (item.content as Record<string, unknown>[]) ?? [];
      for (const c of contents) {
        if (c.type === 'output_text') {
          blocks.push({ type: 'text', text: c.text as string });
        }
      }
    } else if (item.type === 'function_call') {
      let input: Record<string, unknown> = {};
      try {
        input = item.arguments ? JSON.parse(item.arguments as string) : {};
      } catch {
        // malformed JSON — leave empty
      }
      blocks.push({
        type: 'tool_use',
        id: item.call_id as string,
        name: item.name as string,
        input,
      });
    }
  }

  return { content: blocks, hasFunctionCalls };
}

/** Build Responses API params from a CompletionRequest */
function buildParams(
  request: CompletionRequest,
  streaming: boolean,
): Record<string, unknown> {
  const input = toInputItems(request.messages);
  const reasoning = isReasoningModel(request.model);

  const params: Record<string, unknown> = {
    model: request.model,
    input,
  };

  if (streaming) {
    params.stream = true;
  }
  if (request.systemPrompt) {
    params.instructions = request.systemPrompt;
  }
  if (request.maxTokens !== undefined) {
    params.max_output_tokens = request.maxTokens;
  }
  if (!reasoning && request.temperature !== undefined) {
    params.temperature = request.temperature;
  }
  if (request.thinking && reasoning) {
    params.reasoning = { effort: 'high', summary: 'auto' };
  }
  if (request.tools?.length) {
    params.tools = request.tools.map((t) => ({
      type: 'function' as const,
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    }));
  }

  return params;
}

export class OpenAIProvider implements LlmProvider {
  readonly name = 'openai';
  private client: OpenAI;

  constructor(apiKey?: string) {
    this.client = new OpenAI({ apiKey });
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const params = buildParams(request, false);

    const response = await this.client.responses.create(
      params as Parameters<typeof this.client.responses.create>[0],
    );

    const res = response as unknown as Record<string, unknown>;
    const outputItems = res.output as Record<string, unknown>[];
    const { content, hasFunctionCalls } = fromOutputItems(outputItems ?? []);
    const usage = res.usage as Record<string, number> | undefined;
    const status = res.status as string;

    return {
      content,
      model: request.model,
      usage: {
        inputTokens: usage?.input_tokens ?? 0,
        outputTokens: usage?.output_tokens ?? 0,
      },
      stopReason: mapStopReason(status, hasFunctionCalls),
    };
  }

  async *stream(request: CompletionRequest): AsyncGenerator<StreamChunk, CompletionResponse> {
    const params = buildParams(request, true);

    const stream = await this.client.responses.create(
      params as Parameters<typeof this.client.responses.create>[0],
    );

    let fullText = '';
    const toolUseBlocks: ToolUseBlock[] = [];
    const thinkingBlocks: ThinkingBlock[] = [];
    let currentThinking = '';
    let currentToolCallId = '';
    let currentToolName = '';
    let lastUsage = { inputTokens: 0, outputTokens: 0 };
    let lastStatus = 'completed';

    for await (const event of stream as AsyncIterable<Record<string, unknown>>) {
      const eventType = event.type as string;

      if (eventType === 'response.output_text.delta') {
        const delta = event.delta as string;
        fullText += delta;
        yield { type: 'text_delta', text: delta };
      } else if (eventType === 'response.output_item.added') {
        const item = event.item as Record<string, unknown>;
        if (item.type === 'function_call') {
          currentToolCallId = item.call_id as string;
          currentToolName = item.name as string;
          yield {
            type: 'tool_use_start',
            toolUse: { id: currentToolCallId, name: currentToolName },
          };
        }
      } else if (eventType === 'response.function_call_arguments.delta') {
        yield {
          type: 'tool_use_delta',
          toolUseDelta: { partial_json: event.delta as string },
        };
      } else if (eventType === 'response.function_call_arguments.done') {
        let input: Record<string, unknown> = {};
        try {
          input = event.arguments ? JSON.parse(event.arguments as string) : {};
        } catch {
          // malformed JSON
        }
        toolUseBlocks.push({
          type: 'tool_use',
          id: event.call_id as string,
          name: event.name as string,
          input,
        });
        currentToolCallId = '';
        currentToolName = '';
      } else if (eventType === 'response.reasoning_summary_text.delta') {
        const delta = event.delta as string;
        currentThinking += delta;
        yield { type: 'thinking_delta', thinking: delta };
      } else if (eventType === 'response.reasoning_summary_text.done') {
        thinkingBlocks.push({
          type: 'thinking',
          thinking: currentThinking,
          signature: '',
        });
        currentThinking = '';
        yield { type: 'thinking_stop', signature: '' };
      } else if (eventType === 'response.completed') {
        const resp = event.response as Record<string, unknown>;
        const usage = resp.usage as Record<string, number> | undefined;
        lastUsage = {
          inputTokens: usage?.input_tokens ?? 0,
          outputTokens: usage?.output_tokens ?? 0,
        };
        lastStatus = resp.status as string;
      }
    }

    const hasFunctionCalls = toolUseBlocks.length > 0;
    const stopReason = mapStopReason(lastStatus, hasFunctionCalls);

    yield { type: 'stop', stopReason };

    // Build final content
    let content: string | ContentBlock[];
    if (toolUseBlocks.length > 0 || thinkingBlocks.length > 0) {
      const blocks: ContentBlock[] = [];
      blocks.push(...thinkingBlocks);
      if (fullText) blocks.push({ type: 'text', text: fullText });
      blocks.push(...toolUseBlocks);
      content = blocks;
    } else {
      content = fullText;
    }

    return {
      content,
      model: request.model,
      usage: lastUsage,
      stopReason,
    };
  }
}
