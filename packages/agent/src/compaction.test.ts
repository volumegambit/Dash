import type { LlmProvider, Message } from '@dash/llm';
import { describe, expect, it, vi } from 'vitest';
import { compactSession, estimateTokens, shouldCompact } from './compaction.js';

describe('estimateTokens', () => {
  it('estimates tokens for string content messages', () => {
    const messages: Message[] = [
      { role: 'user', content: 'Hello world' },
      { role: 'assistant', content: 'Hi there!' },
    ];
    const totalChars = 'Hello world'.length + 'Hi there!'.length;
    expect(estimateTokens(messages)).toBe(Math.ceil(totalChars / 4));
  });

  it('estimates tokens for ContentBlock[] content', () => {
    const block = { type: 'text' as const, text: 'hello' };
    const messages: Message[] = [{ role: 'user', content: [block] }];
    const serialized = JSON.stringify([{ type: 'text', text: 'hello' }]);
    expect(estimateTokens(messages)).toBe(Math.ceil(serialized.length / 4));
  });
});

describe('shouldCompact', () => {
  it('returns false when under threshold', () => {
    const messages: Message[] = [{ role: 'user', content: 'short message' }];
    expect(shouldCompact(messages, 200000)).toBe(false);
  });

  it('returns true when over threshold', () => {
    const longString = 'x'.repeat(161000);
    const messages: Message[] = [{ role: 'user', content: longString }];
    expect(shouldCompact(messages, 50000)).toBe(true);
  });
});

describe('compactSession', () => {
  it('calls provider and returns summary', async () => {
    const mockComplete = vi.fn().mockResolvedValue({
      content: 'Summary text',
      model: 'test',
      usage: { inputTokens: 10, outputTokens: 50 },
      stopReason: 'end_turn',
    });
    const mockProvider: LlmProvider = {
      name: 'mock',
      complete: mockComplete,
      stream: vi.fn() as LlmProvider['stream'],
    };

    const messages: Message[] = [{ role: 'user', content: 'Do something.' }];
    const result = await compactSession(messages, mockProvider, 'test-model');

    expect(result).toBe('Summary text');
    expect(mockComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'test-model',
        messages: expect.arrayContaining([
          { role: 'user', content: 'Please summarize this conversation.' },
        ]),
      }),
    );
    const callArg = mockComplete.mock.calls[0][0];
    const lastMessage = callArg.messages[callArg.messages.length - 1];
    expect(lastMessage).toEqual({ role: 'user', content: 'Please summarize this conversation.' });
  });
});
