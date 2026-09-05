import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '@dash/agent';
import type { MemoryInfo } from '@dash/agent';
import type {
  ConversationContent,
  ConversationMessage,
  ConversationRole,
} from '@dash/mobile-contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationService } from './conversation-service.js';
import type { MemorySweepOptions } from './memory-sweep.js';
import { createMemorySweepService } from './memory-sweep.js';

interface MessageSpec {
  turnId: string;
  role: ConversationRole;
  content: ConversationContent;
}

/**
 * Minimal stand-in for {@link ConversationService.listMessages}. The real page
 * is `{ items, nextCursor, throughSeq }` ordered oldest-first within the page.
 */
function fakeConversations(
  specs: MessageSpec[],
  spy?: ReturnType<typeof vi.fn>,
): Pick<ConversationService, 'listMessages'> {
  const items: ConversationMessage[] = specs.map((spec, i) => ({
    id: `m${i}`,
    conversationId: 'c',
    turnId: spec.turnId,
    ordinal: i,
    role: spec.role,
    status: 'completed',
    content: spec.content,
    createdAt: '2026-09-05T00:00:00.000Z',
    updatedAt: '2026-09-05T00:00:00.000Z',
  }));
  return {
    listMessages: (input) => {
      spy?.(input);
      return { items, nextCursor: null, throughSeq: items.length };
    },
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !predicate(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('createMemorySweepService', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dash-sweep-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('extracts from the finished turn and writes memories with source sweep', async () => {
    const store = new MemoryStore(dir);
    const extract = vi.fn(async () => [
      {
        name: 'user-timezone',
        description: 'Gerry is in Singapore',
        type: 'user' as const,
        content: 'UTC+8',
      },
    ]);
    const listSpy = vi.fn();
    const svc = createMemorySweepService({
      conversations: fakeConversations(
        [
          { turnId: 't0', role: 'user', content: { type: 'user', text: 'an older turn' } },
          {
            turnId: 't0',
            role: 'assistant',
            content: {
              type: 'assistant',
              events: [{ type: 'response', content: 'older reply', usage: {} }],
            },
          },
          { turnId: 't1', role: 'user', content: { type: 'user', text: 'I live in Singapore' } },
          {
            turnId: 't1',
            role: 'assistant',
            content: {
              type: 'assistant',
              events: [
                { type: 'text_delta', text: 'Noted' },
                { type: 'response', content: 'Noted', usage: {} },
              ],
            },
          },
        ],
        listSpy,
      ),
      memoryStore: () => store,
      shouldSweep: () => true,
      extract,
    });

    svc.schedule({ agentId: 'a', conversationId: 'c', turnId: 't1' });
    await svc.flush();

    expect(listSpy).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'c' }));
    expect(extract).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'a',
        userText: 'I live in Singapore',
        assistantText: 'Noted',
      }),
    );
    expect((await store.get('user-timezone'))?.source).toBe('sweep');
  });

  it('passes the current memory index to the extractor', async () => {
    const store = new MemoryStore(dir);
    await store.save({
      name: 'user-name',
      description: 'The user is called Gerry',
      type: 'user',
      content: 'Gerry',
      source: 'agent',
    });
    const extract = vi.fn<MemorySweepOptions['extract']>(async () => []);
    const svc = createMemorySweepService({
      conversations: fakeConversations([
        { turnId: 't1', role: 'user', content: { type: 'user', text: 'hi' } },
        {
          turnId: 't1',
          role: 'assistant',
          content: { type: 'assistant', events: [{ type: 'response', content: 'yo', usage: {} }] },
        },
      ]),
      memoryStore: () => store,
      shouldSweep: () => true,
      extract,
    });

    svc.schedule({ agentId: 'a', conversationId: 'c', turnId: 't1' });
    await svc.flush();

    const index = extract.mock.calls[0]?.[0]?.index ?? [];
    expect(index.map((m: MemoryInfo) => m.name)).toEqual(['user-name']);
  });

  it('skips when the policy says no, when memory is off, or when the turn already saved a memory', async () => {
    const extract = vi.fn(async () => []);
    const withSave = fakeConversations([
      { turnId: 't1', role: 'user', content: { type: 'user', text: 'x' } },
      {
        turnId: 't1',
        role: 'assistant',
        content: {
          type: 'assistant',
          events: [
            { type: 'tool_result', id: '1', name: 'save_memory', content: 'Saved', isError: false },
            { type: 'response', content: '', usage: {} },
          ],
        },
      },
    ]);
    const a = createMemorySweepService({
      conversations: withSave,
      memoryStore: () => new MemoryStore(dir),
      shouldSweep: () => true,
      extract,
    });
    a.schedule({ agentId: 'a', conversationId: 'c', turnId: 't1' });
    await a.flush();

    const b = createMemorySweepService({
      conversations: fakeConversations([]),
      memoryStore: () => null,
      shouldSweep: () => true,
      extract,
    });
    b.schedule({ agentId: 'a', conversationId: 'c', turnId: 't1' });
    await b.flush();

    const c = createMemorySweepService({
      conversations: fakeConversations([]),
      memoryStore: () => new MemoryStore(dir),
      shouldSweep: () => false,
      extract,
    });
    c.schedule({ agentId: 'a', conversationId: 'c', turnId: 't1' });
    await c.flush();

    expect(extract).not.toHaveBeenCalled();
  });

  it('still sweeps when a memory tool call failed', async () => {
    const extract = vi.fn(async () => []);
    const svc = createMemorySweepService({
      conversations: fakeConversations([
        { turnId: 't1', role: 'user', content: { type: 'user', text: 'x' } },
        {
          turnId: 't1',
          role: 'assistant',
          content: {
            type: 'assistant',
            events: [
              {
                type: 'tool_result',
                id: '1',
                name: 'save_memory',
                content: 'Invalid name',
                isError: true,
              },
              { type: 'response', content: 'sorry', usage: {} },
            ],
          },
        },
      ]),
      memoryStore: () => new MemoryStore(dir),
      shouldSweep: () => true,
      extract,
    });

    svc.schedule({ agentId: 'a', conversationId: 'c', turnId: 't1' });
    await svc.flush();

    expect(extract).toHaveBeenCalledTimes(1);
  });

  it('skips a turn that is not in the page and a turn with no text at all', async () => {
    const extract = vi.fn<MemorySweepOptions['extract']>(async () => []);
    const svc = createMemorySweepService({
      conversations: fakeConversations([
        { turnId: 't1', role: 'user', content: { type: 'user', text: 'hi' } },
      ]),
      memoryStore: () => new MemoryStore(dir),
      shouldSweep: () => true,
      extract,
    });
    svc.schedule({ agentId: 'a', conversationId: 'c', turnId: 'missing' });
    await svc.flush();
    expect(extract).not.toHaveBeenCalled();

    const empty = createMemorySweepService({
      conversations: fakeConversations([
        { turnId: 't1', role: 'user', content: { type: 'user', text: '' } },
        { turnId: 't1', role: 'assistant', content: { type: 'assistant', events: [] } },
      ]),
      memoryStore: () => new MemoryStore(dir),
      shouldSweep: () => true,
      extract,
    });
    empty.schedule({ agentId: 'a', conversationId: 'c', turnId: 't1' });
    await empty.flush();
    expect(extract).not.toHaveBeenCalled();
  });

  it('coalesces a schedule that arrives while a sweep is running into one rerun', async () => {
    let resolveFirst: () => void = () => {};
    const firstCall = new Promise<never[]>((resolve) => {
      resolveFirst = () => resolve([]);
    });
    const extract = vi
      .fn()
      .mockImplementationOnce(() => firstCall)
      .mockResolvedValue([]);
    const conv = fakeConversations([
      { turnId: 't1', role: 'user', content: { type: 'user', text: 'a' } },
      {
        turnId: 't1',
        role: 'assistant',
        content: { type: 'assistant', events: [{ type: 'response', content: 'b', usage: {} }] },
      },
    ]);
    const svc = createMemorySweepService({
      conversations: conv,
      memoryStore: () => new MemoryStore(dir),
      shouldSweep: () => true,
      extract,
    });

    svc.schedule({ agentId: 'a', conversationId: 'c', turnId: 't1' });
    svc.schedule({ agentId: 'a', conversationId: 'c', turnId: 't1' });
    svc.schedule({ agentId: 'a', conversationId: 'c', turnId: 't1' });
    await waitFor(() => extract.mock.calls.length === 1);
    resolveFirst();
    await svc.flush();

    expect(extract).toHaveBeenCalledTimes(2);
  });

  it('logs and swallows extraction failures', async () => {
    const warn = vi.fn();
    const svc = createMemorySweepService({
      conversations: fakeConversations([
        { turnId: 't1', role: 'user', content: { type: 'user', text: 'a' } },
        {
          turnId: 't1',
          role: 'assistant',
          content: { type: 'assistant', events: [{ type: 'response', content: 'b', usage: {} }] },
        },
      ]),
      memoryStore: () => new MemoryStore(dir),
      shouldSweep: () => true,
      extract: async () => {
        throw new Error('boom');
      },
      logger: { info: vi.fn(), warn },
    });

    svc.schedule({ agentId: 'a', conversationId: 'c', turnId: 't1' });
    await svc.flush();

    expect(warn).toHaveBeenCalledWith(
      'memory sweep failed',
      expect.objectContaining({ error: 'boom' }),
    );
  });

  it('logs and skips a candidate the store rejects but saves the rest', async () => {
    const warn = vi.fn();
    const store = new MemoryStore(dir);
    const svc = createMemorySweepService({
      conversations: fakeConversations([
        { turnId: 't1', role: 'user', content: { type: 'user', text: 'a' } },
        {
          turnId: 't1',
          role: 'assistant',
          content: { type: 'assistant', events: [{ type: 'response', content: 'b', usage: {} }] },
        },
      ]),
      memoryStore: () => store,
      shouldSweep: () => true,
      extract: async () => [
        { name: 'BAD NAME', description: 'x', type: 'user' as const, content: 'y' },
        { name: 'good-one', description: 'x', type: 'user' as const, content: 'y' },
      ],
      logger: { info: vi.fn(), warn },
    });

    svc.schedule({ agentId: 'a', conversationId: 'c', turnId: 't1' });
    await svc.flush();

    expect(await store.get('good-one')).not.toBeNull();
    expect(warn).toHaveBeenCalledWith(
      'memory sweep dropped a candidate',
      expect.objectContaining({ name: 'BAD NAME' }),
    );
  });

  it('flush resolves when nothing is scheduled', async () => {
    const svc = createMemorySweepService({
      conversations: fakeConversations([]),
      memoryStore: () => null,
      shouldSweep: () => true,
      extract: async () => [],
    });
    await expect(svc.flush()).resolves.toBeUndefined();
  });
});
