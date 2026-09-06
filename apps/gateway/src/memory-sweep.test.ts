import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '@dash/agent';
import type { MemoryInfo } from '@dash/agent';
import type { ConversationContent, ConversationRole } from '@dash/mobile-contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoredConversationMessage } from './conversation-domain.js';
import type { ConversationService } from './conversation-service.js';
import type { MemorySweepOptions } from './memory-sweep.js';
import { createMemorySweepService } from './memory-sweep.js';

interface MessageSpec {
  turnId: string;
  runId?: string;
  segmentIndex?: number;
  deliveryKind?: StoredConversationMessage['deliveryKind'];
  deliveryStatus?: StoredConversationMessage['deliveryStatus'];
  role: ConversationRole;
  content: ConversationContent;
}

/**
 * Minimal stand-in for {@link ConversationService.listRunMessages}. The real
 * method returns every run segment ordered by message ordinal.
 */
function fakeConversations(
  specs: MessageSpec[],
  spy?: ReturnType<typeof vi.fn>,
): Pick<ConversationService, 'listRunMessages'> {
  const items: StoredConversationMessage[] = specs.map((spec, i) => ({
    id: `m${i}`,
    conversationId: 'c',
    turnId: spec.turnId,
    runId: spec.runId ?? spec.turnId,
    segmentIndex: spec.segmentIndex ?? 0,
    ordinal: i,
    role: spec.role,
    status: 'completed',
    deliveryKind: spec.deliveryKind ?? ((spec.segmentIndex ?? 0) > 0 ? 'steer' : 'normal'),
    deliveryStatus: spec.deliveryStatus,
    content: spec.content,
    createdAt: '2026-09-05T00:00:00.000Z',
    updatedAt: '2026-09-05T00:00:00.000Z',
  }));
  return {
    listRunMessages: (conversationId, runId) => {
      spy?.(conversationId, runId);
      return items.filter(
        (message) => message.conversationId === conversationId && message.runId === runId,
      );
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

    svc.schedule({ agentId: 'a', conversationId: 'c', runId: 't1' });
    await svc.flush();

    expect(listSpy).toHaveBeenCalledWith('c', 't1');
    expect(extract).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'a',
        userText: 'I live in Singapore',
        assistantText: 'Noted',
      }),
    );
    expect((await store.get('user-timezone'))?.source).toBe('sweep');
  });

  it('sweeps all user and assistant segments once in ordinal order', async () => {
    const extract = vi.fn(async () => []);
    const svc = createMemorySweepService({
      conversations: fakeConversations([
        {
          turnId: 'run-1',
          runId: 'run-1',
          segmentIndex: 0,
          role: 'user',
          content: { type: 'user', text: 'initial' },
        },
        {
          turnId: 'run-1',
          runId: 'run-1',
          segmentIndex: 0,
          role: 'assistant',
          content: {
            type: 'assistant',
            events: [
              { type: 'text_delta', text: 'first' },
              { type: 'response', content: 'first', usage: {} },
            ],
          },
        },
        {
          turnId: 'segment-1',
          runId: 'run-1',
          segmentIndex: 1,
          deliveryStatus: 'delivered',
          role: 'user',
          content: { type: 'user', text: 'steer' },
        },
        {
          turnId: 'segment-1',
          runId: 'run-1',
          segmentIndex: 1,
          role: 'assistant',
          content: {
            type: 'assistant',
            events: [
              { type: 'text_delta', text: 'second' },
              { type: 'response', content: 'second', usage: {} },
            ],
          },
        },
      ]),
      memoryStore: () => new MemoryStore(dir),
      shouldSweep: () => true,
      extract,
    });

    svc.schedule({ agentId: 'a', conversationId: 'c', runId: 'run-1' });
    await svc.flush();

    expect(extract).toHaveBeenCalledOnce();
    expect(extract).toHaveBeenCalledWith(
      expect.objectContaining({
        userText: 'initial\n\nsteer',
        assistantText: 'first\n\nsecond',
      }),
    );
  });

  it.each([
    { deliveryStatus: 'pending' as const, initialKind: 'normal' as const },
    { deliveryStatus: 'not_delivered' as const, initialKind: 'follow_up' as const },
  ])(
    'excludes a $deliveryStatus Steer while retaining the $initialKind user message',
    async ({ deliveryStatus, initialKind }) => {
      const extract = vi.fn(async () => []);
      const svc = createMemorySweepService({
        conversations: fakeConversations([
          {
            turnId: 'run-1',
            deliveryKind: initialKind,
            role: 'user',
            content: { type: 'user', text: 'eligible instruction' },
          },
          {
            turnId: 'run-1',
            role: 'assistant',
            content: {
              type: 'assistant',
              events: [{ type: 'response', content: 'first', usage: {} }],
            },
          },
          {
            turnId: 'segment-1',
            runId: 'run-1',
            segmentIndex: 1,
            deliveryStatus,
            role: 'user',
            content: { type: 'user', text: 'never delivered instruction' },
          },
        ]),
        memoryStore: () => new MemoryStore(dir),
        shouldSweep: () => true,
        extract,
      });

      svc.schedule({ agentId: 'a', conversationId: 'c', runId: 'run-1' });
      await svc.flush();

      expect(extract).toHaveBeenCalledWith(
        expect.objectContaining({
          userText: 'eligible instruction',
          assistantText: 'first',
        }),
      );
    },
  );

  it('skips a run when any segment successfully saved or forgot a memory', async () => {
    const extract = vi.fn(async () => []);
    const svc = createMemorySweepService({
      conversations: fakeConversations([
        { turnId: 'run-1', role: 'user', content: { type: 'user', text: 'initial' } },
        {
          turnId: 'run-1',
          role: 'assistant',
          content: {
            type: 'assistant',
            events: [{ type: 'response', content: 'first', usage: {} }],
          },
        },
        {
          turnId: 'segment-1',
          runId: 'run-1',
          segmentIndex: 1,
          deliveryStatus: 'delivered',
          role: 'user',
          content: { type: 'user', text: 'forget that' },
        },
        {
          turnId: 'segment-1',
          runId: 'run-1',
          segmentIndex: 1,
          role: 'assistant',
          content: {
            type: 'assistant',
            events: [
              {
                type: 'tool_result',
                id: 'forget-1',
                name: 'forget_memory',
                content: 'Forgotten',
                isError: false,
              },
              { type: 'response', content: 'done', usage: {} },
            ],
          },
        },
      ]),
      memoryStore: () => new MemoryStore(dir),
      shouldSweep: () => true,
      extract,
    });

    svc.schedule({ agentId: 'a', conversationId: 'c', runId: 'run-1' });
    await svc.flush();

    expect(extract).not.toHaveBeenCalled();
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

    svc.schedule({ agentId: 'a', conversationId: 'c', runId: 't1' });
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
    a.schedule({ agentId: 'a', conversationId: 'c', runId: 't1' });
    await a.flush();

    const b = createMemorySweepService({
      conversations: fakeConversations([]),
      memoryStore: () => null,
      shouldSweep: () => true,
      extract,
    });
    b.schedule({ agentId: 'a', conversationId: 'c', runId: 't1' });
    await b.flush();

    const c = createMemorySweepService({
      conversations: fakeConversations([]),
      memoryStore: () => new MemoryStore(dir),
      shouldSweep: () => false,
      extract,
    });
    c.schedule({ agentId: 'a', conversationId: 'c', runId: 't1' });
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

    svc.schedule({ agentId: 'a', conversationId: 'c', runId: 't1' });
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
    svc.schedule({ agentId: 'a', conversationId: 'c', runId: 'missing' });
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
    empty.schedule({ agentId: 'a', conversationId: 'c', runId: 't1' });
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

    svc.schedule({ agentId: 'a', conversationId: 'c', runId: 't1' });
    svc.schedule({ agentId: 'a', conversationId: 'c', runId: 't1' });
    svc.schedule({ agentId: 'a', conversationId: 'c', runId: 't1' });
    await waitFor(() => extract.mock.calls.length === 1);
    resolveFirst();
    await svc.flush();

    expect(extract).toHaveBeenCalledTimes(2);
  });

  it('drains a schedule that arrives during the second sweep pass', async () => {
    let resolveFirst: () => void = () => {};
    let resolveSecond: () => void = () => {};
    const firstCall = new Promise<never[]>((resolve) => {
      resolveFirst = () => resolve([]);
    });
    const secondCall = new Promise<never[]>((resolve) => {
      resolveSecond = () => resolve([]);
    });
    const extract = vi
      .fn()
      .mockImplementationOnce(() => firstCall)
      .mockImplementationOnce(() => secondCall)
      .mockResolvedValue([]);
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
      extract,
    });

    svc.schedule({ agentId: 'a', conversationId: 'c', runId: 't1' });
    await waitFor(() => extract.mock.calls.length === 1);
    svc.schedule({ agentId: 'a', conversationId: 'c', runId: 't1' });
    resolveFirst();
    await waitFor(() => extract.mock.calls.length === 2);
    svc.schedule({ agentId: 'a', conversationId: 'c', runId: 't1' });
    resolveSecond();
    await svc.flush();

    expect(extract).toHaveBeenCalledTimes(3);
  });

  it('runs a queued sweep rerun after the first pass fails', async () => {
    let rejectFirst: (error: Error) => void = () => {};
    const firstCall = new Promise<never[]>((_, reject) => {
      rejectFirst = reject;
    });
    const warn = vi.fn();
    const extract = vi
      .fn()
      .mockImplementationOnce(() => firstCall)
      .mockResolvedValue([]);
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
      extract,
      logger: { info: vi.fn(), warn },
    });

    svc.schedule({ agentId: 'a', conversationId: 'c', runId: 't1' });
    await waitFor(() => extract.mock.calls.length === 1);
    svc.schedule({ agentId: 'a', conversationId: 'c', runId: 't1' });
    rejectFirst(new Error('first pass failed'));
    await svc.flush();

    expect(extract).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(
      'memory sweep failed',
      expect.objectContaining({ error: 'first pass failed' }),
    );
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

    svc.schedule({ agentId: 'a', conversationId: 'c', runId: 't1' });
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

    svc.schedule({ agentId: 'a', conversationId: 'c', runId: 't1' });
    await svc.flush();

    expect(await store.get('good-one')).not.toBeNull();
    expect(warn).toHaveBeenCalledWith(
      'memory sweep dropped a candidate',
      expect.objectContaining({ name: 'BAD NAME' }),
    );
  });

  it('refuses to overwrite a user-authored memory but still saves the rest', async () => {
    const warn = vi.fn();
    const store = new MemoryStore(dir);
    await store.save({
      name: 'user-timezone',
      description: 'Gerry is in Singapore',
      type: 'user',
      content: 'UTC+8, do not change',
      source: 'user',
    });
    const svc = createMemorySweepService({
      conversations: fakeConversations([
        { turnId: 't1', role: 'user', content: { type: 'user', text: 'I am in Tokyo today' } },
        {
          turnId: 't1',
          role: 'assistant',
          content: { type: 'assistant', events: [{ type: 'response', content: 'ok', usage: {} }] },
        },
      ]),
      memoryStore: () => store,
      shouldSweep: () => true,
      extract: async () => [
        {
          name: 'user-timezone',
          description: 'Gerry is in Tokyo',
          type: 'user' as const,
          content: 'Gerry is in Tokyo',
        },
        { name: 'other-fact', description: 'x', type: 'project' as const, content: 'y' },
      ],
      logger: { info: vi.fn(), warn },
    });

    svc.schedule({ agentId: 'a', conversationId: 'c', runId: 't1' });
    await svc.flush();

    const kept = await store.get('user-timezone');
    expect(kept?.source).toBe('user');
    expect(kept?.content).toBe('UTC+8, do not change');
    expect(warn).toHaveBeenCalledWith(
      'memory sweep refused to overwrite a user-authored memory',
      expect.objectContaining({ name: 'user-timezone' }),
    );
    expect(await store.get('other-fact')).not.toBeNull();
  });

  it('refuses to overwrite an imported (user-authored) memory', async () => {
    const warn = vi.fn();
    const store = new MemoryStore(dir);
    // The legacy import holds the user's hand-written workspace MEMORY.md under
    // the larger import budget — the sweep would truncate it to 2048 chars.
    const imported = `${'user notes, hand written. '.repeat(200)}end`;
    await store.save({
      name: 'legacy-memory-md',
      description: 'Imported from the workspace MEMORY.md',
      type: 'project',
      content: imported,
      source: 'import',
    });
    const svc = createMemorySweepService({
      conversations: fakeConversations([
        { turnId: 't1', role: 'user', content: { type: 'user', text: 'note this' } },
        {
          turnId: 't1',
          role: 'assistant',
          content: { type: 'assistant', events: [{ type: 'response', content: 'ok', usage: {} }] },
        },
      ]),
      memoryStore: () => store,
      shouldSweep: () => true,
      extract: async () => [
        {
          name: 'legacy-memory-md',
          description: 'rewritten by the sweep',
          type: 'project' as const,
          content: 'a much shorter note',
        },
      ],
      logger: { info: vi.fn(), warn },
    });

    svc.schedule({ agentId: 'a', conversationId: 'c', runId: 't1' });
    await svc.flush();

    const kept = await store.get('legacy-memory-md');
    expect(kept?.source).toBe('import');
    expect(kept?.content).toBe(imported);
    expect(warn).toHaveBeenCalledWith(
      'memory sweep refused to overwrite a user-authored memory',
      expect.objectContaining({ name: 'legacy-memory-md' }),
    );
  });

  it('still updates memories written by the agent or a previous sweep', async () => {
    const store = new MemoryStore(dir);
    await store.save({
      name: 'agent-fact',
      description: 'old',
      type: 'project',
      content: 'old body',
      source: 'agent',
    });
    await store.save({
      name: 'sweep-fact',
      description: 'old',
      type: 'project',
      content: 'old body',
      source: 'sweep',
    });
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
        { name: 'agent-fact', description: 'new', type: 'project' as const, content: 'new body' },
        { name: 'sweep-fact', description: 'new', type: 'project' as const, content: 'new body' },
      ],
    });

    svc.schedule({ agentId: 'a', conversationId: 'c', runId: 't1' });
    await svc.flush();

    expect((await store.get('agent-fact'))?.content).toBe('new body');
    expect((await store.get('sweep-fact'))?.content).toBe('new body');
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
