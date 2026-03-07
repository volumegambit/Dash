import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompletionRequest, ContentBlock, Message } from '../types.js';

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
      let result: IteratorResult<
        import('../types.js').StreamChunk,
        import('../types.js').CompletionResponse
      >;

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
      let result: IteratorResult<
        import('../types.js').StreamChunk,
        import('../types.js').CompletionResponse
      >;

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
      let result: IteratorResult<
        import('../types.js').StreamChunk,
        import('../types.js').CompletionResponse
      >;

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
      let result: IteratorResult<
        import('../types.js').StreamChunk,
        import('../types.js').CompletionResponse
      >;
      do {
        result = await gen.next();
      } while (!result.done);

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.stream).toBe(true);
    });
  });
});
