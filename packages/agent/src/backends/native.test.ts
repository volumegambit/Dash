import { describe, expect, it } from 'vitest';
import { NativeBackend } from './native.js';
import type { AgentState } from '../types.js';
import type { LlmProvider, CompletionResponse, StreamChunk } from '@dash/llm';

function makeState(model: string, fallbackModels?: string[]): AgentState {
  return {
    session: {
      id: 'test',
      channelId: 'ch',
      conversationId: 'conv',
      createdAt: new Date().toISOString(),
      messages: [],
    },
    systemPrompt: 'you are helpful',
    model,
    fallbackModels,
  };
}

describe('NativeBackend fallback', () => {
  it('uses primary model when it succeeds', async () => {
    const provider: LlmProvider = {
      name: 'test',
      complete: async () => ({}) as CompletionResponse,
      async *stream(): AsyncGenerator<StreamChunk, CompletionResponse> {
        yield { type: 'text_delta', text: 'hello' };
        yield { type: 'stop', stopReason: 'end_turn' };
        return {
          content: 'hello',
          model: 'test-model',
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: 'end_turn',
        } as CompletionResponse;
      },
    };

    const backend = new NativeBackend(provider);
    const events: Array<{ type: string }> = [];

    for await (const event of backend.run(makeState('test/primary'), {})) {
      events.push(event);
    }

    const responseEvent = events.find((e) => e.type === 'response');
    expect(responseEvent).toBeDefined();
    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent).toBeUndefined();
  });

  it('falls back to next model on retryable error', async () => {
    let callCount = 0;
    const provider: LlmProvider = {
      name: 'test',
      complete: async () => ({}) as CompletionResponse,
      async *stream(): AsyncGenerator<StreamChunk, CompletionResponse> {
        callCount++;
        if (callCount === 1) throw new Error('429 rate limit exceeded');
        yield { type: 'text_delta', text: 'fallback response' };
        yield { type: 'stop', stopReason: 'end_turn' };
        return {
          content: 'fallback response',
          model: 'fallback',
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: 'end_turn',
        } as CompletionResponse;
      },
    };

    const backend = new NativeBackend(provider);
    const events: Array<{ type: string; text?: string }> = [];

    for await (const event of backend.run(
      makeState('test/primary', ['test/fallback']),
      {},
    )) {
      events.push(event);
    }

    const switchMsg = events.find(
      (e) => e.type === 'text_delta' && (e as { text?: string }).text?.includes('Switching to fallback'),
    );
    expect(switchMsg).toBeDefined();
    const responseEvent = events.find((e) => e.type === 'response');
    expect(responseEvent).toBeDefined();
    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent).toBeUndefined();
  });

  it('yields error after all models exhausted', async () => {
    const provider: LlmProvider = {
      name: 'test',
      complete: async () => ({}) as CompletionResponse,
      async *stream(): AsyncGenerator<StreamChunk, CompletionResponse> {
        throw new Error('503 service unavailable');
        yield { type: 'stop' } as StreamChunk;
        return {} as CompletionResponse;
      },
    };

    const backend = new NativeBackend(provider);
    const events: Array<{ type: string }> = [];

    for await (const event of backend.run(
      makeState('test/primary', ['test/fallback1']),
      {},
    )) {
      events.push(event);
    }

    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent).toBeDefined();
  });

  it('does not fall back on non-retryable errors', async () => {
    let callCount = 0;
    const provider: LlmProvider = {
      name: 'test',
      complete: async () => ({}) as CompletionResponse,
      async *stream(): AsyncGenerator<StreamChunk, CompletionResponse> {
        callCount++;
        throw new Error('401 unauthorized');
        yield { type: 'stop' } as StreamChunk;
        return {} as CompletionResponse;
      },
    };

    const backend = new NativeBackend(provider);
    const events: Array<{ type: string }> = [];

    for await (const event of backend.run(
      makeState('test/primary', ['test/fallback']),
      {},
    )) {
      events.push(event);
    }

    expect(callCount).toBe(1); // only tried primary, not fallback
    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent).toBeDefined();
  });
});
