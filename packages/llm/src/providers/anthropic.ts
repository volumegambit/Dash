import Anthropic from '@anthropic-ai/sdk';
import type {
  CompletionRequest,
  CompletionResponse,
  ContentBlock,
  LlmProvider,
  StreamChunk,
  TextBlock,
  ThinkingBlock,
  RedactedThinkingBlock,
  ToolUseBlock,
} from '../types.js';

type SdkMessage = Anthropic.MessageParam;
type SdkContent = Anthropic.ContentBlockParam;

/** Map our Message[] to Anthropic SDK format, handling ContentBlock[] content */
function toSdkMessages(messages: CompletionRequest['messages']): SdkMessage[] {
  return messages
    .filter((m) => m.role !== 'system')
    .map((m) => {
      if (typeof m.content === 'string') {
        return { role: m.role as 'user' | 'assistant', content: m.content };
      }
      // ContentBlock[] — map each block to SDK format
      const blocks: SdkContent[] = m.content.map((block) => {
        if (block.type === 'thinking') {
          return { type: 'thinking' as const, thinking: block.thinking, signature: block.signature };
        }
        if (block.type === 'redacted_thinking') {
          return { type: 'redacted_thinking' as const, data: block.data };
        }
        if (block.type === 'text') {
          return { type: 'text' as const, text: block.text };
        }
        if (block.type === 'tool_use') {
          return {
            type: 'tool_use' as const,
            id: block.id,
            name: block.name,
            input: block.input,
          };
        }
        if (block.type === 'tool_result') {
          return {
            type: 'tool_result' as const,
            tool_use_id: block.tool_use_id,
            content: block.content,
            is_error: block.is_error,
          };
        }
        return { type: 'text' as const, text: '' };
      });
      return { role: m.role as 'user' | 'assistant', content: blocks };
    });
}

/** Convert SDK response content to our types. Returns string if text-only, ContentBlock[] if tool_use or thinking present */
function fromSdkContent(
  sdkContent: Anthropic.Messages.ContentBlock[],
): string | ContentBlock[] {
  const hasToolUse = sdkContent.some((b) => b.type === 'tool_use');
  const hasThinking = sdkContent.some((b) => b.type === 'thinking' || b.type === 'redacted_thinking');
  if (!hasToolUse && !hasThinking) {
    return sdkContent
      .filter((b) => b.type === 'text')
      .map((b) => (b as Anthropic.Messages.TextBlock).text)
      .join('');
  }
  return sdkContent.map((b) => {
    if (b.type === 'thinking') {
      const tb = b as Anthropic.Messages.ThinkingBlock;
      return { type: 'thinking', thinking: tb.thinking, signature: tb.signature } as ThinkingBlock;
    }
    if (b.type === 'redacted_thinking') {
      const rb = b as Anthropic.Messages.RedactedThinkingBlock;
      return { type: 'redacted_thinking', data: rb.data } as RedactedThinkingBlock;
    }
    if (b.type === 'text') {
      return { type: 'text', text: (b as Anthropic.Messages.TextBlock).text } as TextBlock;
    }
    const tu = b as Anthropic.Messages.ToolUseBlock;
    return {
      type: 'tool_use',
      id: tu.id,
      name: tu.name,
      input: tu.input as Record<string, unknown>,
    } as ToolUseBlock;
  });
}

export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic';
  private client: Anthropic;

  constructor(apiKey?: string) {
    this.client = new Anthropic({ apiKey });
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: request.model,
      max_tokens: request.maxTokens ?? 4096,
      system: request.systemPrompt,
      messages: toSdkMessages(request.messages),
      temperature: request.thinking ? undefined : request.temperature,
      stop_sequences: request.stopSequences,
      thinking: request.thinking
        ? { type: 'enabled' as const, budget_tokens: request.thinking.budgetTokens }
        : undefined,
    };
    if (request.tools?.length) {
      params.tools = request.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema as Anthropic.Messages.Tool['input_schema'],
      }));
    }

    const response = await this.client.messages.create(params);

    return {
      content: fromSdkContent(response.content),
      model: response.model,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
      stopReason: response.stop_reason as CompletionResponse['stopReason'],
    };
  }

  async *stream(request: CompletionRequest): AsyncGenerator<StreamChunk, CompletionResponse> {
    const params: Anthropic.MessageCreateParamsStreaming = {
      model: request.model,
      max_tokens: request.maxTokens ?? 4096,
      system: request.systemPrompt,
      messages: toSdkMessages(request.messages),
      temperature: request.thinking ? undefined : request.temperature,
      stop_sequences: request.stopSequences,
      stream: true,
      thinking: request.thinking
        ? { type: 'enabled' as const, budget_tokens: request.thinking.budgetTokens }
        : undefined,
    };
    if (request.tools?.length) {
      params.tools = request.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema as Anthropic.Messages.Tool['input_schema'],
      }));
    }

    const stream = this.client.messages.stream(params);

    let fullText = '';
    const toolUseBlocks: ToolUseBlock[] = [];
    const thinkingBlocks: (ThinkingBlock | RedactedThinkingBlock)[] = [];
    let currentToolId = '';
    let currentToolName = '';
    let currentToolJson = '';
    let currentThinking = '';
    let currentSignature = '';
    let inThinking = false;

    for await (const event of stream) {
      if (event.type === 'content_block_start') {
        const block = event.content_block;
        if (block.type === 'tool_use') {
          currentToolId = block.id;
          currentToolName = block.name;
          currentToolJson = '';
          yield {
            type: 'tool_use_start',
            toolUse: { id: block.id, name: block.name },
          };
        } else if (block.type === 'thinking') {
          inThinking = true;
          currentThinking = '';
          currentSignature = '';
        } else if (block.type === 'redacted_thinking') {
          thinkingBlocks.push({
            type: 'redacted_thinking',
            data: (block as Anthropic.Messages.RedactedThinkingBlock).data,
          });
        }
      } else if (event.type === 'content_block_delta') {
        if (event.delta.type === 'thinking_delta') {
          const delta = (event.delta as { type: 'thinking_delta'; thinking: string }).thinking;
          currentThinking += delta;
          yield { type: 'thinking_delta', thinking: delta };
        } else if (event.delta.type === 'signature_delta') {
          currentSignature += (event.delta as { type: 'signature_delta'; signature: string }).signature;
        } else if (event.delta.type === 'text_delta') {
          fullText += event.delta.text;
          yield { type: 'text_delta', text: event.delta.text };
        } else if (event.delta.type === 'input_json_delta') {
          currentToolJson += event.delta.partial_json;
          yield {
            type: 'tool_use_delta',
            toolUseDelta: { partial_json: event.delta.partial_json },
          };
        }
      } else if (event.type === 'content_block_stop') {
        if (inThinking) {
          thinkingBlocks.push({
            type: 'thinking',
            thinking: currentThinking,
            signature: currentSignature,
          });
          inThinking = false;
          yield { type: 'thinking_stop', signature: currentSignature };
        } else if (currentToolId) {
          let input: Record<string, unknown> = {};
          try {
            input = currentToolJson ? JSON.parse(currentToolJson) : {};
          } catch {
            // malformed JSON — leave empty
          }
          toolUseBlocks.push({
            type: 'tool_use',
            id: currentToolId,
            name: currentToolName,
            input,
          });
          currentToolId = '';
          currentToolName = '';
          currentToolJson = '';
        }
      }
    }

    const finalMessage = await stream.finalMessage();
    const stopReason = finalMessage.stop_reason as CompletionResponse['stopReason'];

    yield { type: 'stop', stopReason };

    // Build content: string if text-only, ContentBlock[] if tool_use or thinking present
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
      model: finalMessage.model,
      usage: {
        inputTokens: finalMessage.usage.input_tokens,
        outputTokens: finalMessage.usage.output_tokens,
      },
      stopReason,
    };
  }
}
