import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { CompletionRequest, Message } from '../types.js';

// Mock the @google/genai module
const mockGenerateContent = vi.fn();
const mockGenerateContentStream = vi.fn();

vi.mock('@google/genai', () => {
  return {
    GoogleGenAI: vi.fn().mockImplementation(() => ({
      models: {
        generateContent: mockGenerateContent,
        generateContentStream: mockGenerateContentStream,
      },
    })),
  };
});

const mockUUID = '550e8400-e29b-41d4-a716-446655440000';
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    randomUUID: vi.fn(() => mockUUID),
  };
});

// Import after mocking
import { GoogleProvider } from './google.js';

describe('GoogleProvider', () => {
  let provider: GoogleProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new GoogleProvider('test-api-key');
  });

  it('has name "google"', () => {
    expect(provider.name).toBe('google');
  });

  describe('complete()', () => {
    it('returns text response as string', async () => {
      mockGenerateContent.mockResolvedValue({
        candidates: [
          {
            content: {
              parts: [{ text: 'Hello, world!' }],
              role: 'model',
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 5,
        },
      });

      const request: CompletionRequest = {
        model: 'gemini-2.0-flash',
        messages: [{ role: 'user', content: 'Hi' }],
      };

      const response = await provider.complete(request);

      expect(response.content).toBe('Hello, world!');
      expect(response.stopReason).toBe('end_turn');
      expect(response.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
      expect(response.model).toBe('gemini-2.0-flash');

      // Verify the SDK was called with correct params
      expect(mockGenerateContent).toHaveBeenCalledWith({
        model: 'gemini-2.0-flash',
        contents: [{ role: 'user', parts: [{ text: 'Hi' }] }],
        config: {},
      });
    });

    it('returns tool use response as ContentBlock[]', async () => {
      mockGenerateContent.mockResolvedValue({
        candidates: [
          {
            content: {
              parts: [
                { text: 'Let me check that.' },
                {
                  functionCall: {
                    id: 'call-123',
                    name: 'get_weather',
                    args: { city: 'London' },
                  },
                },
              ],
              role: 'model',
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: {
          promptTokenCount: 15,
          candidatesTokenCount: 20,
        },
      });

      const request: CompletionRequest = {
        model: 'gemini-2.0-flash',
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
      const blocks = response.content as import('../types.js').ContentBlock[];
      expect(blocks).toHaveLength(2);
      expect(blocks[0]).toEqual({ type: 'text', text: 'Let me check that.' });
      expect(blocks[1]).toEqual({
        type: 'tool_use',
        id: 'call-123',
        name: 'get_weather',
        input: { city: 'London' },
      });
    });

    it('maps tool_result with name from conversation history', async () => {
      // Simulate a conversation with tool use and tool result
      const messages: Message[] = [
        { role: 'user', content: 'What is the weather?' },
        {
          role: 'assistant',
          content: [
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

      mockGenerateContent.mockResolvedValue({
        candidates: [
          {
            content: {
              parts: [{ text: 'The weather in Paris is sunny, 22C.' }],
              role: 'model',
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: {
          promptTokenCount: 30,
          candidatesTokenCount: 10,
        },
      });

      const request: CompletionRequest = {
        model: 'gemini-2.0-flash',
        messages,
      };

      await provider.complete(request);

      // Verify the tool_result was mapped with the correct name
      const callArgs = mockGenerateContent.mock.calls[0][0];
      const contents = callArgs.contents;

      // The user message with tool_result should be mapped to a functionResponse
      const toolResultMessage = contents[2]; // third message
      expect(toolResultMessage.role).toBe('user');
      expect(toolResultMessage.parts[0].functionResponse).toEqual({
        id: 'call-abc',
        name: 'get_weather',
        response: { result: 'Sunny, 22C' },
      });
    });

    it('passes systemPrompt, maxTokens, temperature, stopSequences', async () => {
      mockGenerateContent.mockResolvedValue({
        candidates: [
          {
            content: { parts: [{ text: 'OK' }], role: 'model' },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1 },
      });

      await provider.complete({
        model: 'gemini-2.0-flash',
        messages: [{ role: 'user', content: 'test' }],
        systemPrompt: 'You are helpful.',
        maxTokens: 1024,
        temperature: 0.5,
        stopSequences: ['END'],
      });

      const callArgs = mockGenerateContent.mock.calls[0][0];
      expect(callArgs.config.systemInstruction).toBe('You are helpful.');
      expect(callArgs.config.maxOutputTokens).toBe(1024);
      expect(callArgs.config.temperature).toBe(0.5);
      expect(callArgs.config.stopSequences).toEqual(['END']);
    });

    it('passes thinking config', async () => {
      mockGenerateContent.mockResolvedValue({
        candidates: [
          {
            content: {
              parts: [
                { text: 'thinking text', thought: true },
                { text: 'response' },
              ],
              role: 'model',
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 10 },
      });

      await provider.complete({
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', content: 'think hard' }],
        thinking: { type: 'enabled', budgetTokens: 5000 },
      });

      const callArgs = mockGenerateContent.mock.calls[0][0];
      expect(callArgs.config.thinkingConfig).toEqual({
        includeThoughts: true,
        thinkingBudget: 5000,
      });
    });

    it('passes tools as functionDeclarations', async () => {
      mockGenerateContent.mockResolvedValue({
        candidates: [
          {
            content: { parts: [{ text: 'OK' }], role: 'model' },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1 },
      });

      await provider.complete({
        model: 'gemini-2.0-flash',
        messages: [{ role: 'user', content: 'test' }],
        tools: [
          {
            name: 'my_tool',
            description: 'A tool',
            input_schema: { type: 'object', properties: {} },
          },
        ],
      });

      const callArgs = mockGenerateContent.mock.calls[0][0];
      expect(callArgs.config.tools).toEqual([
        {
          functionDeclarations: [
            {
              name: 'my_tool',
              description: 'A tool',
              parameters: { type: 'object', properties: {} },
            },
          ],
        },
      ]);
    });

    it('maps MAX_TOKENS finish reason to max_tokens', async () => {
      mockGenerateContent.mockResolvedValue({
        candidates: [
          {
            content: { parts: [{ text: 'truncated' }], role: 'model' },
            finishReason: 'MAX_TOKENS',
          },
        ],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 100 },
      });

      const response = await provider.complete({
        model: 'gemini-2.0-flash',
        messages: [{ role: 'user', content: 'test' }],
      });

      expect(response.stopReason).toBe('max_tokens');
    });

    it('filters out system messages and maps roles correctly', async () => {
      mockGenerateContent.mockResolvedValue({
        candidates: [
          {
            content: { parts: [{ text: 'OK' }], role: 'model' },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1 },
      });

      await provider.complete({
        model: 'gemini-2.0-flash',
        messages: [
          { role: 'system', content: 'You are a bot' },
          { role: 'user', content: 'Hi' },
          { role: 'assistant', content: 'Hello' },
          { role: 'user', content: 'Bye' },
        ],
      });

      const callArgs = mockGenerateContent.mock.calls[0][0];
      const contents = callArgs.contents;
      // System messages should be filtered out
      expect(contents).toHaveLength(3);
      expect(contents[0].role).toBe('user');
      expect(contents[1].role).toBe('model');
      expect(contents[2].role).toBe('user');
    });

    it('returns thinking blocks as ContentBlock[]', async () => {
      mockGenerateContent.mockResolvedValue({
        candidates: [
          {
            content: {
              parts: [
                { text: 'I need to think...', thought: true, thoughtSignature: 'sig123' },
                { text: 'The answer is 42.' },
              ],
              role: 'model',
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 20 },
      });

      const response = await provider.complete({
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', content: 'What is the meaning of life?' }],
        thinking: { type: 'enabled', budgetTokens: 5000 },
      });

      expect(Array.isArray(response.content)).toBe(true);
      const blocks = response.content as import('../types.js').ContentBlock[];
      expect(blocks[0]).toEqual({
        type: 'thinking',
        thinking: 'I need to think...',
        signature: 'sig123',
      });
      expect(blocks[1]).toEqual({
        type: 'text',
        text: 'The answer is 42.',
      });
    });
  });

  describe('stream()', () => {
    it('streams text chunks', async () => {
      // Create async iterable of chunks
      async function* mockStream() {
        yield {
          candidates: [
            {
              content: { parts: [{ text: 'Hello' }], role: 'model' },
              finishReason: undefined,
            },
          ],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1 },
        };
        yield {
          candidates: [
            {
              content: { parts: [{ text: ', world!' }], role: 'model' },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 },
        };
      }

      mockGenerateContentStream.mockResolvedValue(mockStream());

      const request: CompletionRequest = {
        model: 'gemini-2.0-flash',
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

      // Should have text_delta chunks plus a stop chunk
      expect(chunks).toEqual([
        { type: 'text_delta', text: 'Hello' },
        { type: 'text_delta', text: ', world!' },
        { type: 'stop', stopReason: 'end_turn' },
      ]);

      // The return value should be the final CompletionResponse
      const finalResponse = result.value;
      expect(finalResponse.content).toBe('Hello, world!');
      expect(finalResponse.stopReason).toBe('end_turn');
      expect(finalResponse.usage).toEqual({ inputTokens: 5, outputTokens: 3 });
    });

    it('streams function call chunks', async () => {
      async function* mockStream() {
        yield {
          candidates: [
            {
              content: { parts: [{ text: 'Let me check.' }], role: 'model' },
              finishReason: undefined,
            },
          ],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 5 },
        };
        yield {
          candidates: [
            {
              content: {
                parts: [
                  {
                    functionCall: {
                      id: 'call-456',
                      name: 'search',
                      args: { query: 'weather' },
                    },
                  },
                ],
                role: 'model',
              },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 15 },
        };
      }

      mockGenerateContentStream.mockResolvedValue(mockStream());

      const request: CompletionRequest = {
        model: 'gemini-2.0-flash',
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
        toolUseDelta: { partial_json: '{"query":"weather"}' },
      });
      expect(chunks[3]).toEqual({ type: 'stop', stopReason: 'tool_use' });

      const finalResponse = result.value;
      expect(Array.isArray(finalResponse.content)).toBe(true);
      const blocks = finalResponse.content as import('../types.js').ContentBlock[];
      expect(blocks).toContainEqual({ type: 'text', text: 'Let me check.' });
      expect(blocks).toContainEqual({
        type: 'tool_use',
        id: 'call-456',
        name: 'search',
        input: { query: 'weather' },
      });
    });

    it('streams thinking chunks', async () => {
      async function* mockStream() {
        yield {
          candidates: [
            {
              content: {
                parts: [{ text: 'Let me think...', thought: true }],
                role: 'model',
              },
              finishReason: undefined,
            },
          ],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 5 },
        };
        yield {
          candidates: [
            {
              content: {
                parts: [{ text: 'The answer is 42.' }],
                role: 'model',
              },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 15 },
        };
      }

      mockGenerateContentStream.mockResolvedValue(mockStream());

      const request: CompletionRequest = {
        model: 'gemini-2.5-flash',
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
      expect(chunks[1]).toEqual({ type: 'text_delta', text: 'The answer is 42.' });
      expect(chunks[2]).toEqual({ type: 'stop', stopReason: 'end_turn' });

      const finalResponse = result.value;
      expect(Array.isArray(finalResponse.content)).toBe(true);
      const blocks = finalResponse.content as import('../types.js').ContentBlock[];
      expect(blocks[0]).toMatchObject({ type: 'thinking', thinking: 'Let me think...' });
      expect(blocks[1]).toEqual({ type: 'text', text: 'The answer is 42.' });
    });

    it('generates UUID for function calls without id', async () => {

      async function* mockStream() {
        yield {
          candidates: [
            {
              content: {
                parts: [
                  {
                    functionCall: {
                      name: 'my_func',
                      args: { x: 1 },
                    },
                  },
                ],
                role: 'model',
              },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 10 },
        };
      }

      mockGenerateContentStream.mockResolvedValue(mockStream());

      const gen = provider.stream({
        model: 'gemini-2.0-flash',
        messages: [{ role: 'user', content: 'test' }],
      });

      const chunks: import('../types.js').StreamChunk[] = [];
      let result: IteratorResult<import('../types.js').StreamChunk, import('../types.js').CompletionResponse>;

      do {
        result = await gen.next();
        if (!result.done) {
          chunks.push(result.value);
        }
      } while (!result.done);

      expect(chunks[0]).toEqual({
        type: 'tool_use_start',
        toolUse: { id: mockUUID, name: 'my_func' },
      });
    });
  });
});
