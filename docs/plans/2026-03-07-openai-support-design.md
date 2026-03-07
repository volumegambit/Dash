# OpenAI Provider Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add an `OpenAIProvider` to the LLM layer so Dash agents can use OpenAI GPT and reasoning models via the Responses API.

**Architecture:** Single `OpenAIProvider` class implementing `LlmProvider`, using the `openai` npm SDK's Responses API. Model-aware branching for reasoning models (o1/o3/o4) vs GPT models. Follows the same pattern as the existing `GoogleProvider`.

**Tech Stack:** TypeScript, `openai` npm SDK, Vitest for testing

---

### Task 1: Add openai SDK dependency

**Files:**
- Modify: `packages/llm/package.json`

**Step 1: Add the dependency**

Add `"openai"` to `dependencies` in `packages/llm/package.json`:

```json
"dependencies": {
    "@anthropic-ai/sdk": "^0.39.0",
    "@google/genai": "^1.44.0",
    "openai": "^5.8.0"
}
```

**Step 2: Install dependencies**

Run: `npm install`
Expected: Clean install, lock file updated

**Step 3: Commit**

```bash
git add packages/llm/package.json package-lock.json
git commit -m "feat: add openai SDK dependency to llm package"
```

---

### Task 2: OpenAI provider complete() — basic text, config params, tools, reasoning

**Files:**
- Create: `packages/llm/src/providers/openai.test.ts`
- Create: `packages/llm/src/providers/openai.ts`

**Step 1: Write the failing tests**

Create `packages/llm/src/providers/openai.test.ts`:

```typescript
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { CompletionRequest, Message, ContentBlock } from '../types.js';

// Mock the openai module
const mockCreate = vi.fn();

vi.mock('openai', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      responses: {
        create: mockCreate,
      },
    })),
  };
});

// Import after mocking
import { OpenAIProvider } from './openai.js';

describe('OpenAIProvider', () => {
  let provider: OpenAIProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new OpenAIProvider('test-api-key');
  });

  it('has name "openai"', () => {
    expect(provider.name).toBe('openai');
  });

  describe('complete()', () => {
    it('returns text response as string', async () => {
      mockCreate.mockResolvedValue({
        output: [
          {
            type: 'message',
            content: [{ type: 'output_text', text: 'Hello, world!' }],
          },
        ],
        status: 'completed',
        usage: { input_tokens: 10, output_tokens: 5 },
      });

      const request: CompletionRequest = {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hi' }],
      };

      const response = await provider.complete(request);

      expect(response.content).toBe('Hello, world!');
      expect(response.stopReason).toBe('end_turn');
      expect(response.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
      expect(response.model).toBe('gpt-4o');

      // Verify SDK was called with correct params
      expect(mockCreate).toHaveBeenCalledWith({
        model: 'gpt-4o',
        input: [{ role: 'user', content: 'Hi' }],
      });
    });

    it('passes instructions, max_output_tokens, temperature for GPT models', async () => {
      mockCreate.mockResolvedValue({
        output: [
          {
            type: 'message',
            content: [{ type: 'output_text', text: 'OK' }],
          },
        ],
        status: 'completed',
        usage: { input_tokens: 5, output_tokens: 1 },
      });

      await provider.complete({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'test' }],
        systemPrompt: 'You are helpful.',
        maxTokens: 1024,
        temperature: 0.5,
      });

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.instructions).toBe('You are helpful.');
      expect(callArgs.max_output_tokens).toBe(1024);
      expect(callArgs.temperature).toBe(0.5);
    });

    it('omits temperature for reasoning models', async () => {
      mockCreate.mockResolvedValue({
        output: [
          {
            type: 'message',
            content: [{ type: 'output_text', text: 'OK' }],
          },
        ],
        status: 'completed',
        usage: { input_tokens: 5, output_tokens: 1 },
      });

      await provider.complete({
        model: 'o3',
        messages: [{ role: 'user', content: 'test' }],
        temperature: 0.5,
      });

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.temperature).toBeUndefined();
    });

    it('passes reasoning config for reasoning models with thinking enabled', async () => {
      mockCreate.mockResolvedValue({
        output: [
          {
            type: 'reasoning',
            summary: [{ type: 'summary_text', text: 'I thought about it.' }],
          },
          {
            type: 'message',
            content: [{ type: 'output_text', text: 'The answer is 42.' }],
          },
        ],
        status: 'completed',
        usage: { input_tokens: 10, output_tokens: 20 },
      });

      const response = await provider.complete({
        model: 'o3',
        messages: [{ role: 'user', content: 'think hard' }],
        thinking: { type: 'enabled', budgetTokens: 5000 },
      });

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.reasoning).toEqual({ effort: 'high', summary: 'auto' });

      // Should return ContentBlock[] with thinking + text
      expect(Array.isArray(response.content)).toBe(true);
      const blocks = response.content as ContentBlock[];
      expect(blocks[0]).toEqual({
        type: 'thinking',
        thinking: 'I thought about it.',
        signature: '',
      });
      expect(blocks[1]).toEqual({
        type: 'text',
        text: 'The answer is 42.',
      });
    });

    it('returns tool use response as ContentBlock[]', async () => {
      mockCreate.mockResolvedValue({
        output: [
          {
            type: 'message',
            content: [{ type: 'output_text', text: 'Let me check that.' }],
          },
          {
            type: 'function_call',
            call_id: 'call-123',
            name: 'get_weather',
            arguments: '{"city":"London"}',
          },
        ],
        status: 'completed',
        usage: { input_tokens: 15, output_tokens: 20 },
      });

      const request: CompletionRequest = {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'What is the weather in London?' }],
        tools: [
          {
            name: 'get_weather',
            description: 'Get weather for a city',
            input_schema: { type: 'object', properties: { city: { type: 'string' } } },
          },
        ],
      };

      const response = await provider.complete(request);

      expect(response.stopReason).toBe('tool_use');
      expect(Array.isArray(response.content)).toBe(true);
      const blocks = response.content as ContentBlock[];
      expect(blocks).toHaveLength(2);
      expect(blocks[0]).toEqual({ type: 'text', text: 'Let me check that.' });
      expect(blocks[1]).toEqual({
        type: 'tool_use',
        id: 'call-123',
        name: 'get_weather',
        input: { city: 'London' },
      });

      // Verify tools were passed correctly
      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.tools).toEqual([
        {
          type: 'function',
          name: 'get_weather',
          description: 'Get weather for a city',
          parameters: { type: 'object', properties: { city: { type: 'string' } } },
        },
      ]);
    });

    it('maps tool_result and tool_use in conversation history', async () => {
      const messages: Message[] = [
        { role: 'user', content: 'What is the weather?' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Let me check.' },
            {
              type: 'tool_use',
              id: 'call-abc',
              name: 'get_weather',
              input: { city: 'Paris' },
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call-abc',
              content: 'Sunny, 22C',
            },
          ],
        },
      ];

      mockCreate.mockResolvedValue({
        output: [
          {
            type: 'message',
            content: [{ type: 'output_text', text: 'The weather in Paris is sunny, 22C.' }],
          },
        ],
        status: 'completed',
        usage: { input_tokens: 30, output_tokens: 10 },
      });

      await provider.complete({ model: 'gpt-4o', messages });

      const callArgs = mockCreate.mock.calls[0][0];
      const input = callArgs.input;

      // First: user message
      expect(input[0]).toEqual({ role: 'user', content: 'What is the weather?' });
      // Second: assistant text as output message
      expect(input[1]).toEqual({
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Let me check.' }],
      });
      // Third: function call
      expect(input[2]).toEqual({
        type: 'function_call',
        id: 'call-abc',
        call_id: 'call-abc',
        name: 'get_weather',
        arguments: '{"city":"Paris"}',
      });
      // Fourth: function call output
      expect(input[3]).toEqual({
        type: 'function_call_output',
        call_id: 'call-abc',
        output: 'Sunny, 22C',
      });
    });

    it('filters out system messages from input', async () => {
      mockCreate.mockResolvedValue({
        output: [
          {
            type: 'message',
            content: [{ type: 'output_text', text: 'OK' }],
          },
        ],
        status: 'completed',
        usage: { input_tokens: 5, output_tokens: 1 },
      });

      await provider.complete({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: 'You are a bot' },
          { role: 'user', content: 'Hi' },
          { role: 'assistant', content: 'Hello' },
          { role: 'user', content: 'Bye' },
        ],
      });

      const callArgs = mockCreate.mock.calls[0][0];
      const input = callArgs.input;
      // System messages should be filtered out
      expect(input).toHaveLength(3);
      expect(input[0]).toEqual({ role: 'user', content: 'Hi' });
      expect(input[1]).toEqual({
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Hello' }],
      });
      expect(input[2]).toEqual({ role: 'user', content: 'Bye' });
    });

    it('maps incomplete status to max_tokens', async () => {
      mockCreate.mockResolvedValue({
        output: [
          {
            type: 'message',
            content: [{ type: 'output_text', text: 'truncated' }],
          },
        ],
        status: 'incomplete',
        usage: { input_tokens: 5, output_tokens: 100 },
      });

      const response = await provider.complete({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'test' }],
      });

      expect(response.stopReason).toBe('max_tokens');
    });

    it('handles empty output gracefully', async () => {
      mockCreate.mockResolvedValue({
        output: [],
        status: 'completed',
        usage: { input_tokens: 5, output_tokens: 0 },
      });

      const response = await provider.complete({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'test' }],
      });

      expect(response.content).toBe('');
      expect(response.stopReason).toBe('end_turn');
      expect(response.usage).toEqual({ inputTokens: 5, outputTokens: 0 });
    });

    it('skips thinking and redacted_thinking blocks in input', async () => {
      mockCreate.mockResolvedValue({
        output: [
          {
            type: 'message',
            content: [{ type: 'output_text', text: 'OK' }],
          },
        ],
        status: 'completed',
        usage: { input_tokens: 5, output_tokens: 1 },
      });

      await provider.complete({
        model: 'gpt-4o',
        messages: [
          { role: 'user', content: 'test' },
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'hmm...', signature: 'sig' },
              { type: 'redacted_thinking', data: 'redacted' },
              { type: 'text', text: 'response' },
            ],
          },
        ],
      });

      const callArgs = mockCreate.mock.calls[0][0];
      const input = callArgs.input;
      // Only the text block should be mapped, thinking blocks skipped
      expect(input).toHaveLength(2);
      expect(input[0]).toEqual({ role: 'user', content: 'test' });
      expect(input[1]).toEqual({
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'response' }],
      });
    });
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd packages/llm && npx vitest run src/providers/openai.test.ts`
Expected: FAIL — `openai.js` module not found

**Step 3: Write the implementation**

Create `packages/llm/src/providers/openai.ts`:

```typescript
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

export class OpenAIProvider implements LlmProvider {
  readonly name = 'openai';
  private client: OpenAI;

  constructor(apiKey?: string) {
    this.client = new OpenAI({ apiKey });
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const input = toInputItems(request.messages);
    const reasoning = isReasoningModel(request.model);

    const params: Record<string, unknown> = {
      model: request.model,
      input,
    };

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

    const response = await this.client.responses.create(params as Parameters<typeof this.client.responses.create>[0]);

    const outputItems = (response as Record<string, unknown>).output as Record<string, unknown>[];
    const { content, hasFunctionCalls } = fromOutputItems(outputItems ?? []);
    const usage = (response as Record<string, unknown>).usage as Record<string, number> | undefined;
    const status = (response as Record<string, unknown>).status as string;

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
    // Implemented in Task 3
    throw new Error('Not implemented');
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `cd packages/llm && npx vitest run src/providers/openai.test.ts`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add packages/llm/src/providers/openai.ts packages/llm/src/providers/openai.test.ts
git commit -m "feat: add OpenAIProvider with complete() method"
```

---

### Task 3: OpenAI provider stream() method

**Files:**
- Modify: `packages/llm/src/providers/openai.test.ts` (add stream tests)
- Modify: `packages/llm/src/providers/openai.ts` (implement stream)

**Step 1: Write the failing stream tests**

Append to the `describe('OpenAIProvider')` block in `openai.test.ts`:

```typescript
  describe('stream()', () => {
    it('streams text chunks', async () => {
      async function* mockStream() {
        yield { type: 'response.output_text.delta', delta: 'Hello' };
        yield { type: 'response.output_text.delta', delta: ', world!' };
        yield {
          type: 'response.completed',
          response: {
            status: 'completed',
            usage: { input_tokens: 5, output_tokens: 3 },
          },
        };
      }

      mockCreate.mockResolvedValue(mockStream());

      const request: CompletionRequest = {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hi' }],
      };

      const chunks: import('../types.js').StreamChunk[] = [];
      const gen = provider.stream(request);
      let result: IteratorResult<import('../types.js').StreamChunk, import('../types.js').CompletionResponse>;

      do {
        result = await gen.next();
        if (!result.done) {
          chunks.push(result.value);
        }
      } while (!result.done);

      expect(chunks).toEqual([
        { type: 'text_delta', text: 'Hello' },
        { type: 'text_delta', text: ', world!' },
        { type: 'stop', stopReason: 'end_turn' },
      ]);

      const finalResponse = result.value;
      expect(finalResponse.content).toBe('Hello, world!');
      expect(finalResponse.stopReason).toBe('end_turn');
      expect(finalResponse.usage).toEqual({ inputTokens: 5, outputTokens: 3 });
    });

    it('streams function call chunks', async () => {
      async function* mockStream() {
        yield { type: 'response.output_text.delta', delta: 'Let me check.' };
        yield {
          type: 'response.output_item.added',
          item: { type: 'function_call', call_id: 'call-456', name: 'search' },
        };
        yield {
          type: 'response.function_call_arguments.delta',
          delta: '{"query":',
        };
        yield {
          type: 'response.function_call_arguments.delta',
          delta: '"weather"}',
        };
        yield {
          type: 'response.function_call_arguments.done',
          call_id: 'call-456',
          name: 'search',
          arguments: '{"query":"weather"}',
        };
        yield {
          type: 'response.completed',
          response: {
            status: 'completed',
            usage: { input_tokens: 5, output_tokens: 15 },
          },
        };
      }

      mockCreate.mockResolvedValue(mockStream());

      const request: CompletionRequest = {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Search for weather' }],
        tools: [
          {
            name: 'search',
            description: 'Search the web',
            input_schema: { type: 'object', properties: { query: { type: 'string' } } },
          },
        ],
      };

      const chunks: import('../types.js').StreamChunk[] = [];
      const gen = provider.stream(request);
      let result: IteratorResult<import('../types.js').StreamChunk, import('../types.js').CompletionResponse>;

      do {
        result = await gen.next();
        if (!result.done) {
          chunks.push(result.value);
        }
      } while (!result.done);

      expect(chunks[0]).toEqual({ type: 'text_delta', text: 'Let me check.' });
      expect(chunks[1]).toEqual({
        type: 'tool_use_start',
        toolUse: { id: 'call-456', name: 'search' },
      });
      expect(chunks[2]).toEqual({
        type: 'tool_use_delta',
        toolUseDelta: { partial_json: '{"query":' },
      });
      expect(chunks[3]).toEqual({
        type: 'tool_use_delta',
        toolUseDelta: { partial_json: '"weather"}' },
      });
      expect(chunks[4]).toEqual({ type: 'stop', stopReason: 'tool_use' });

      const finalResponse = result.value;
      expect(Array.isArray(finalResponse.content)).toBe(true);
      const blocks = finalResponse.content as ContentBlock[];
      expect(blocks).toContainEqual({ type: 'text', text: 'Let me check.' });
      expect(blocks).toContainEqual({
        type: 'tool_use',
        id: 'call-456',
        name: 'search',
        input: { query: 'weather' },
      });
    });

    it('streams reasoning summary chunks', async () => {
      async function* mockStream() {
        yield { type: 'response.reasoning_summary_text.delta', delta: 'Let me think...' };
        yield { type: 'response.reasoning_summary_text.done', text: 'Let me think...' };
        yield { type: 'response.output_text.delta', delta: 'The answer is 42.' };
        yield {
          type: 'response.completed',
          response: {
            status: 'completed',
            usage: { input_tokens: 5, output_tokens: 15 },
          },
        };
      }

      mockCreate.mockResolvedValue(mockStream());

      const request: CompletionRequest = {
        model: 'o3',
        messages: [{ role: 'user', content: 'Think about life' }],
        thinking: { type: 'enabled', budgetTokens: 5000 },
      };

      const chunks: import('../types.js').StreamChunk[] = [];
      const gen = provider.stream(request);
      let result: IteratorResult<import('../types.js').StreamChunk, import('../types.js').CompletionResponse>;

      do {
        result = await gen.next();
        if (!result.done) {
          chunks.push(result.value);
        }
      } while (!result.done);

      expect(chunks[0]).toEqual({ type: 'thinking_delta', thinking: 'Let me think...' });
      expect(chunks[1]).toEqual({ type: 'thinking_stop', signature: '' });
      expect(chunks[2]).toEqual({ type: 'text_delta', text: 'The answer is 42.' });
      expect(chunks[3]).toEqual({ type: 'stop', stopReason: 'end_turn' });

      const finalResponse = result.value;
      expect(Array.isArray(finalResponse.content)).toBe(true);
      const blocks = finalResponse.content as ContentBlock[];
      expect(blocks[0]).toEqual({ type: 'thinking', thinking: 'Let me think...', signature: '' });
      expect(blocks[1]).toEqual({ type: 'text', text: 'The answer is 42.' });
    });

    it('passes stream: true in params', async () => {
      async function* mockStream() {
        yield {
          type: 'response.completed',
          response: {
            status: 'completed',
            usage: { input_tokens: 5, output_tokens: 1 },
          },
        };
      }

      mockCreate.mockResolvedValue(mockStream());

      const gen = provider.stream({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'test' }],
      });

      // Drain the generator
      let result: IteratorResult<import('../types.js').StreamChunk, import('../types.js').CompletionResponse>;
      do {
        result = await gen.next();
      } while (!result.done);

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.stream).toBe(true);
    });
  });
```

**Step 2: Run tests to verify stream tests fail**

Run: `cd packages/llm && npx vitest run src/providers/openai.test.ts`
Expected: stream tests FAIL with "Not implemented"

**Step 3: Implement stream() method**

Replace the `stream()` stub in `openai.ts` with:

```typescript
  async *stream(request: CompletionRequest): AsyncGenerator<StreamChunk, CompletionResponse> {
    const input = toInputItems(request.messages);
    const reasoning = isReasoningModel(request.model);

    const params: Record<string, unknown> = {
      model: request.model,
      input,
      stream: true,
    };

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

    const stream = await this.client.responses.create(params as Parameters<typeof this.client.responses.create>[0]);

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
```

**Step 4: Run tests to verify they pass**

Run: `cd packages/llm && npx vitest run src/providers/openai.test.ts`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add packages/llm/src/providers/openai.ts packages/llm/src/providers/openai.test.ts
git commit -m "feat: add OpenAIProvider stream() method"
```

---

### Task 4: Wire into config, agent-server, and exports

**Files:**
- Modify: `packages/llm/src/index.ts:17` — add OpenAIProvider export
- Modify: `apps/dash/src/config.ts:23-26,30-39,128-133,219-228,247-257` — add openaiApiKey
- Modify: `apps/dash/src/agent-server.ts:13,21-27` — import and register OpenAIProvider

**Step 1: Write failing registry test**

Add to `packages/llm/src/registry.test.ts`, after the gemini test:

```typescript
  it('resolves gpt- and o-series models to openai provider', () => {
    const registry = new ProviderRegistry();
    const openai = mockProvider('openai');
    registry.register(openai);

    expect(registry.resolveProvider('gpt-4o')).toBe(openai);
    expect(registry.resolveProvider('gpt-4.1')).toBe(openai);
    expect(registry.resolveProvider('o3')).toBe(openai);
    expect(registry.resolveProvider('o4-mini')).toBe(openai);
  });
```

**Step 2: Run test to verify it fails**

Run: `cd packages/llm && npx vitest run src/registry.test.ts`
Expected: FAIL — openai provider not registered (no mock with name 'openai' exists yet). Actually this should PASS since we're creating a mock provider with name 'openai' and the registry already has `gpt-`/`o1`/`o3`/`o4` routing. Verify it passes.

**Step 3: Add export to index.ts**

In `packages/llm/src/index.ts`, add after line 17:

```typescript
export { OpenAIProvider } from './providers/openai.js';
```

**Step 4: Add openaiApiKey to config.ts**

In `apps/dash/src/config.ts`, make these changes:

1. Add `openai` to `CredentialsConfig` (line 23-26):
```typescript
export interface CredentialsConfig {
  anthropic?: { apiKey?: string };
  google?: { apiKey?: string };
  openai?: { apiKey?: string };
}
```

2. Add `openaiApiKey` to `DashConfig` (line 30-39):
```typescript
export interface DashConfig {
  anthropicApiKey: string;
  googleApiKey?: string;
  openaiApiKey?: string;
  agents: Record<string, AgentConfig>;
  // ... rest unchanged
}
```

3. Add `openaiApiKey` to `SecretsFile` (line 128-133):
```typescript
interface SecretsFile {
  anthropicApiKey?: string;
  googleApiKey?: string;
  openaiApiKey?: string;
  managementToken?: string;
  chatToken?: string;
}
```

4. Add `openaiApiKey` resolution after `googleApiKey` (after line 228):
```typescript
  const openaiApiKey =
    secrets?.openaiApiKey ?? process.env.OPENAI_API_KEY ?? credentials.openai?.apiKey;
```

5. Add `openaiApiKey` to return object (line 247-257):
```typescript
  return {
    anthropicApiKey,
    googleApiKey,
    openaiApiKey,
    agents: merged.agents,
    // ... rest unchanged
  };
```

**Step 5: Wire OpenAIProvider in agent-server.ts**

In `apps/dash/src/agent-server.ts`:

1. Update import (line 13):
```typescript
import { AnthropicProvider, GoogleProvider, OpenAIProvider, ProviderRegistry } from '@dash/llm';
```

2. Add registration after Google provider (after line 27):
```typescript
  if (config.openaiApiKey) {
    registry.register(new OpenAIProvider(config.openaiApiKey));
  }
```

**Step 6: Run all tests**

Run: `npm test`
Expected: All tests PASS (registry, config, provider tests)

**Step 7: Commit**

```bash
git add packages/llm/src/index.ts packages/llm/src/registry.test.ts apps/dash/src/config.ts apps/dash/src/agent-server.ts
git commit -m "feat: wire OpenAIProvider into agent server and config"
```

---

### Task 5: Update config examples and documentation

**Files:**
- Modify: `config.example/credentials.json`
- Modify: `.env.example`

**Step 1: Update credentials.json**

Update `config.example/credentials.json`:

```json
{
  "anthropic": {
    "apiKey": "sk-ant-..."
  },
  "google": {
    "apiKey": "AIza..."
  },
  "openai": {
    "apiKey": "sk-..."
  },
  "telegram": {
    "botToken": "123456:ABC-DEF..."
  }
}
```

**Step 2: Update .env.example**

Add after `GOOGLE_API_KEY` line in `.env.example`:

```
OPENAI_API_KEY=sk-...
```

**Step 3: Verify build**

Run: `npm run build`
Expected: Clean build with no TypeScript errors

**Step 4: Commit**

```bash
git add config.example/credentials.json .env.example
git commit -m "docs: add OpenAI API key to config examples"
```
