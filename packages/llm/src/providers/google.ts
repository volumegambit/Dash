import { randomUUID } from 'node:crypto';
import { GoogleGenAI } from '@google/genai';
import type {
  CompletionRequest,
  CompletionResponse,
  ContentBlock,
  LlmProvider,
  Message,
  StreamChunk,
  TextBlock,
  ThinkingBlock,
  ToolUseBlock,
} from '../types.js';

import type { Content, Part } from '@google/genai';

/** Build a map of tool_use_id → tool name by scanning all messages for ToolUseBlock entries */
function buildToolNameMap(messages: Message[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const msg of messages) {
    if (typeof msg.content === 'string') continue;
    for (const block of msg.content) {
      if (block.type === 'tool_use') {
        map.set(block.id, block.name);
      }
    }
  }
  return map;
}

/** Map our Message[] to Google SDK Content[] format */
function toSdkContents(messages: Message[]): Content[] {
  const toolNameMap = buildToolNameMap(messages);

  return messages
    .filter((m) => m.role !== 'system')
    .map((m) => {
      const role = m.role === 'assistant' ? 'model' : 'user';

      if (typeof m.content === 'string') {
        return { role, parts: [{ text: m.content }] };
      }

      const parts: Part[] = [];
      for (const block of m.content) {
        if (block.type === 'text') {
          parts.push({ text: block.text });
        } else if (block.type === 'tool_use') {
          parts.push({
            functionCall: {
              id: block.id,
              name: block.name,
              args: block.input,
            },
          });
        } else if (block.type === 'tool_result') {
          const name = toolNameMap.get(block.tool_use_id) ?? 'unknown';
          parts.push({
            functionResponse: {
              id: block.tool_use_id,
              name,
              response: { result: block.content },
            },
          });
        }
        // Skip 'thinking' and 'redacted_thinking' blocks (Anthropic-specific)
      }

      return { role, parts };
    });
}

/** Build the Google SDK config from our CompletionRequest */
function buildConfig(request: CompletionRequest): Record<string, unknown> {
  const config: Record<string, unknown> = {};

  if (request.systemPrompt) {
    config.systemInstruction = request.systemPrompt;
  }
  if (request.maxTokens !== undefined) {
    config.maxOutputTokens = request.maxTokens;
  }
  if (request.temperature !== undefined) {
    config.temperature = request.temperature;
  }
  if (request.stopSequences?.length) {
    config.stopSequences = request.stopSequences;
  }
  if (request.thinking) {
    config.thinkingConfig = {
      includeThoughts: true,
      thinkingBudget: request.thinking.budgetTokens,
    };
  }
  if (request.tools?.length) {
    config.tools = [
      {
        functionDeclarations: request.tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.input_schema,
        })),
      },
    ];
  }

  return config;
}

/** Map Google finish reason to our stop reason */
function mapFinishReason(
  finishReason: string | undefined,
  hasFunctionCalls: boolean,
): CompletionResponse['stopReason'] {
  if (hasFunctionCalls) return 'tool_use';
  if (finishReason === 'MAX_TOKENS') return 'max_tokens';
  // Google does not have a STOP_SEQUENCE finish reason.
  // When stop sequences trigger, the API returns 'STOP'.
  return 'end_turn';
}

/** Convert Google response parts to our content format */
function fromSdkParts(parts: Part[]): {
  content: string | ContentBlock[];
  hasFunctionCalls: boolean;
} {
  const hasFunctionCalls = parts.some((p) => p.functionCall);
  const hasThinking = parts.some((p) => p.thought);

  if (!hasFunctionCalls && !hasThinking) {
    const text = parts
      .filter((p) => p.text !== undefined)
      .map((p) => p.text)
      .join('');
    return { content: text, hasFunctionCalls: false };
  }

  const blocks: ContentBlock[] = [];
  for (const part of parts) {
    if (part.thought && part.text !== undefined) {
      blocks.push({
        type: 'thinking',
        thinking: part.text,
        signature: part.thoughtSignature ?? '',
      } as ThinkingBlock);
    } else if (part.text !== undefined) {
      blocks.push({ type: 'text', text: part.text } as TextBlock);
    } else if (part.functionCall) {
      blocks.push({
        type: 'tool_use',
        id: part.functionCall.id ?? randomUUID(),
        name: part.functionCall.name ?? '',
        input: (part.functionCall.args as Record<string, unknown>) ?? {},
      } as ToolUseBlock);
    }
  }

  return { content: blocks, hasFunctionCalls };
}

export class GoogleProvider implements LlmProvider {
  readonly name = 'google';
  private client: GoogleGenAI;

  constructor(apiKey?: string) {
    this.client = new GoogleGenAI({ apiKey });
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const contents = toSdkContents(request.messages);
    const config = buildConfig(request);

    const response = await this.client.models.generateContent({
      model: request.model,
      contents,
      config,
    });

    const candidate = response.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];
    const { content, hasFunctionCalls } = fromSdkParts(parts);
    const finishReason = candidate?.finishReason;

    return {
      content,
      model: request.model,
      usage: {
        inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
      },
      stopReason: mapFinishReason(finishReason, hasFunctionCalls),
    };
  }

  async *stream(request: CompletionRequest): AsyncGenerator<StreamChunk, CompletionResponse> {
    const contents = toSdkContents(request.messages);
    const config = buildConfig(request);

    const streamResult = await this.client.models.generateContentStream({
      model: request.model,
      contents,
      config,
    });

    let fullText = '';
    const toolUseBlocks: ToolUseBlock[] = [];
    const thinkingBlocks: ThinkingBlock[] = [];
    let lastUsage = { inputTokens: 0, outputTokens: 0 };
    let lastFinishReason: string | undefined;

    for await (const chunk of streamResult) {
      const candidate = chunk.candidates?.[0];
      const parts = candidate?.content?.parts ?? [];

      if (candidate?.finishReason) {
        lastFinishReason = candidate.finishReason;
      }
      if (chunk.usageMetadata) {
        lastUsage = {
          inputTokens: chunk.usageMetadata.promptTokenCount ?? 0,
          outputTokens: chunk.usageMetadata.candidatesTokenCount ?? 0,
        };
      }

      for (const part of parts) {
        if (part.thought && part.text !== undefined) {
          // Thinking part
          thinkingBlocks.push({
            type: 'thinking',
            thinking: part.text,
            signature: part.thoughtSignature ?? '',
          });
          yield { type: 'thinking_delta', thinking: part.text };
          yield { type: 'thinking_stop', signature: part.thoughtSignature ?? '' };
        } else if (part.text !== undefined) {
          // Regular text part
          fullText += part.text;
          yield { type: 'text_delta', text: part.text };
        } else if (part.functionCall) {
          // Function call part
          const id = part.functionCall.id ?? randomUUID();
          const name = part.functionCall.name ?? '';
          const args = (part.functionCall.args as Record<string, unknown>) ?? {};

          toolUseBlocks.push({
            type: 'tool_use',
            id,
            name,
            input: args,
          });

          yield { type: 'tool_use_start', toolUse: { id, name } };
          yield {
            type: 'tool_use_delta',
            toolUseDelta: { partial_json: JSON.stringify(args) },
          };
        }
      }
    }

    const hasFunctionCalls = toolUseBlocks.length > 0;
    const stopReason = mapFinishReason(lastFinishReason, hasFunctionCalls);

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
