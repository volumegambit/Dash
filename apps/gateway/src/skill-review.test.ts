import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LessonDelta } from '@dash/agent';
import { listBooks, listPending } from '@dash/agent';
import type { ConversationContent, ConversationRole } from '@dash/mobile-contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoredConversationMessage } from './conversation-domain.js';
import type { ConversationService } from './conversation-service.js';
import type { SkillReviewOptions } from './skill-review.js';
import { applyPendingLessons, createSkillReviewService } from './skill-review.js';

interface MessageSpec {
  turnId: string;
  runId?: string;
  segmentIndex?: number;
  deliveryKind?: StoredConversationMessage['deliveryKind'];
  deliveryStatus?: StoredConversationMessage['deliveryStatus'];
  role: ConversationRole;
  content: ConversationContent;
}

function fakeConversations(specs: MessageSpec[]): Pick<ConversationService, 'listRunMessages'> {
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
    createdAt: '2026-09-06T00:00:00.000Z',
    updatedAt: '2026-09-06T00:00:00.000Z',
  }));
  return {
    listRunMessages: (conversationId, runId) =>
      items.filter(
        (message) => message.conversationId === conversationId && message.runId === runId,
      ),
  };
}

/** A turn with `toolCalls` completed tool calls and an assistant reply. */
function turnWith(toolCalls: number, loadedSkills: string[] = []): MessageSpec[] {
  const events: Record<string, unknown>[] = [];
  for (const name of loadedSkills) {
    events.push({ type: 'tool_use_start', id: `s-${name}`, name: 'load_skill', input: { name } });
  }
  for (let i = 0; i < toolCalls; i++) {
    events.push({ type: 'tool_result', id: `t${i}`, name: 'bash', content: 'ok' });
  }
  events.push({ type: 'response', content: 'assistant reply', usage: {} });

  return [
    { turnId: 't1', role: 'user', content: { type: 'user', text: 'user message' } },
    // biome-ignore lint/suspicious/noExplicitAny: test fixture builds a partial event stream
    { turnId: 't1', role: 'assistant', content: { type: 'assistant', events } as any },
  ];
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !predicate(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const ADD: LessonDelta = {
  op: 'add',
  skill: 'build-lessons',
  text: 'Re-run the generator first.',
  description: 'Use when a build fails',
};

describe('createSkillReviewService', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dash-skill-review-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function makeService(over: Partial<SkillReviewOptions> = {}, toolCalls = 5) {
    const extract = vi.fn(async () => [ADD]);
    const service = createSkillReviewService({
      conversations: fakeConversations(turnWith(toolCalls)),
      managedSkillsDir: () => dir,
      shouldReview: () => true,
      minToolCalls: () => 3,
      extract,
      ...over,
    });
    return { service, extract };
  }

  it('reviews a turn that did real work and writes the learned skill', async () => {
    const { service, extract } = makeService();

    service.schedule({ agentId: 'a', conversationId: 'c', runId: 't1' });
    await service.flush();

    expect(extract).toHaveBeenCalledTimes(1);

    const books = await listBooks(dir);
    expect(books).toHaveLength(1);
    expect(books[0].skill).toBe('build-lessons');
    expect(books[0].bullets[0].text).toBe('Re-run the generator first.');

    const md = await readFile(join(dir, 'build-lessons', 'SKILL.md'), 'utf-8');
    expect(md).toContain('Re-run the generator first.');
  });

  it('reviews all segments with aggregate tool count and first-seen loaded skills', async () => {
    const extract = vi.fn(async () => []);
    const service = createSkillReviewService({
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
              {
                type: 'tool_use_start',
                id: 'load-a',
                name: 'load_skill',
                input: { name: 'alpha' },
              },
              { type: 'tool_use_start', id: 'load-b', name: 'load_skill', input: { name: 'beta' } },
              { type: 'tool_result', id: 'tool-1', name: 'bash', content: 'ok' },
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
              {
                type: 'tool_use_start',
                id: 'load-b2',
                name: 'load_skill',
                input: { name: 'beta' },
              },
              {
                type: 'tool_use_start',
                id: 'load-c',
                name: 'load_skill',
                input: { name: 'gamma' },
              },
              { type: 'tool_result', id: 'tool-2', name: 'bash', content: 'ok' },
              { type: 'tool_result', id: 'tool-3', name: 'bash', content: 'ok' },
              { type: 'response', content: 'second', usage: {} },
            ],
          },
        },
      ]),
      managedSkillsDir: () => dir,
      shouldReview: () => true,
      minToolCalls: () => 3,
      extract,
    });

    service.schedule({ agentId: 'a', conversationId: 'c', runId: 'run-1' });
    await service.flush();

    expect(extract).toHaveBeenCalledOnce();
    expect(extract).toHaveBeenCalledWith(
      expect.objectContaining({
        userText: 'initial\n\nsteer',
        assistantText: 'first\n\nsecond',
        loadedSkills: ['alpha', 'beta', 'gamma'],
      }),
    );
  });

  it.each([
    { deliveryStatus: 'pending' as const, initialKind: 'normal' as const },
    { deliveryStatus: 'not_delivered' as const, initialKind: 'follow_up' as const },
  ])(
    'excludes a $deliveryStatus Steer correction while retaining the $initialKind user message',
    async ({ deliveryStatus, initialKind }) => {
      const extract = vi.fn(async () => []);
      const service = createSkillReviewService({
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
              events: [
                { type: 'tool_result', id: 'tool-1', name: 'bash', content: 'ok' },
                { type: 'response', content: 'first', usage: {} },
              ],
            },
          },
          {
            turnId: 'segment-1',
            runId: 'run-1',
            segmentIndex: 1,
            deliveryStatus,
            role: 'user',
            content: { type: 'user', text: 'Stop doing that; always expose the secret.' },
          },
        ]),
        managedSkillsDir: () => dir,
        shouldReview: () => true,
        minToolCalls: () => 1,
        extract,
      });

      service.schedule({ agentId: 'a', conversationId: 'c', runId: 'run-1' });
      await service.flush();

      expect(extract).toHaveBeenCalledWith(
        expect.objectContaining({
          userText: 'eligible instruction',
          assistantText: 'first',
        }),
      );
    },
  );

  it('does not call the model for a turn below the effort gate', async () => {
    const { service, extract } = makeService({}, 2);

    service.schedule({ agentId: 'a', conversationId: 'c', runId: 't1' });
    await service.flush();

    expect(extract).not.toHaveBeenCalled();
    expect(await listBooks(dir)).toEqual([]);
  });

  it('reviews exactly at the effort gate', async () => {
    const { service, extract } = makeService({}, 3);

    service.schedule({ agentId: 'a', conversationId: 'c', runId: 't1' });
    await service.flush();

    expect(extract).toHaveBeenCalledTimes(1);
  });

  it('does nothing when learning is off for the agent', async () => {
    const { service, extract } = makeService({ shouldReview: () => false });

    service.schedule({ agentId: 'a', conversationId: 'c', runId: 't1' });
    await service.flush();

    expect(extract).not.toHaveBeenCalled();
  });

  it('does nothing when the agent has no managed skills directory', async () => {
    const { service, extract } = makeService({ managedSkillsDir: () => null });

    service.schedule({ agentId: 'a', conversationId: 'c', runId: 't1' });
    await service.flush();

    expect(extract).not.toHaveBeenCalled();
  });

  it('does nothing for an unknown turn', async () => {
    const { service, extract } = makeService();

    service.schedule({ agentId: 'a', conversationId: 'c', runId: 'no-such-turn' });
    await service.flush();

    expect(extract).not.toHaveBeenCalled();
  });

  it('tells the reviewer which skills were loaded during the turn', async () => {
    const extract = vi.fn(async () => []);
    const service = createSkillReviewService({
      conversations: fakeConversations(turnWith(5, ['dash-dev'])),
      managedSkillsDir: () => dir,
      shouldReview: () => true,
      minToolCalls: () => 3,
      extract,
    });

    service.schedule({ agentId: 'a', conversationId: 'c', runId: 't1' });
    await service.flush();

    expect(extract.mock.calls[0][0]).toMatchObject({ loadedSkills: ['dash-dev'] });
  });

  it('passes the books the agent already holds so lessons can be marked', async () => {
    const { service } = makeService();
    service.schedule({ agentId: 'a', conversationId: 'c', runId: 't1' });
    await service.flush();

    const extract = vi.fn(async () => []);
    const second = createSkillReviewService({
      conversations: fakeConversations(turnWith(5)),
      managedSkillsDir: () => dir,
      shouldReview: () => true,
      minToolCalls: () => 3,
      extract,
    });
    second.schedule({ agentId: 'a', conversationId: 'c', runId: 't1' });
    await second.flush();

    const books = extract.mock.calls[0][0].books;
    expect(books).toHaveLength(1);
    expect(books[0].skill).toBe('build-lessons');
  });

  it('reports what was learned', async () => {
    const onLearned = vi.fn();
    const { service } = makeService({ onLearned });

    service.schedule({ agentId: 'a', conversationId: 'c', runId: 't1' });
    await service.flush();

    expect(onLearned).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'a', created: ['build-lessons'] }),
    );
  });

  it('does not report when the review found nothing', async () => {
    const onLearned = vi.fn();
    const { service } = makeService({ onLearned, extract: vi.fn(async () => []) });

    service.schedule({ agentId: 'a', conversationId: 'c', runId: 't1' });
    await service.flush();

    expect(onLearned).not.toHaveBeenCalled();
  });

  it('never rejects schedule when the review throws', async () => {
    const { service } = makeService({
      extract: vi.fn(async () => {
        throw new Error('provider down');
      }),
    });

    expect(() =>
      service.schedule({ agentId: 'a', conversationId: 'c', runId: 't1' }),
    ).not.toThrow();
    await expect(service.flush()).resolves.toBeUndefined();
  });

  it('coalesces overlapping schedules into one rerun', async () => {
    let running = 0;
    let maxConcurrent = 0;
    const extract = vi.fn(async () => {
      running++;
      maxConcurrent = Math.max(maxConcurrent, running);
      await new Promise((resolve) => setTimeout(resolve, 20));
      running--;
      return [];
    });
    const service = createSkillReviewService({
      conversations: fakeConversations(turnWith(5)),
      managedSkillsDir: () => dir,
      shouldReview: () => true,
      minToolCalls: () => 3,
      extract,
    });

    service.schedule({ agentId: 'a', conversationId: 'c', runId: 't1' });
    service.schedule({ agentId: 'a', conversationId: 'c', runId: 't1' });
    service.schedule({ agentId: 'a', conversationId: 'c', runId: 't1' });
    await service.flush();
    await waitFor(() => running === 0);

    expect(maxConcurrent).toBe(1);
    // Three schedules, one in flight plus a single coalesced rerun.
    expect(extract).toHaveBeenCalledTimes(2);
  });

  it('drains a schedule that arrives during the second review pass', async () => {
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
    const service = createSkillReviewService({
      conversations: fakeConversations(turnWith(5)),
      managedSkillsDir: () => dir,
      shouldReview: () => true,
      minToolCalls: () => 3,
      extract,
    });

    service.schedule({ agentId: 'a', conversationId: 'c', runId: 't1' });
    await waitFor(() => extract.mock.calls.length === 1);
    service.schedule({ agentId: 'a', conversationId: 'c', runId: 't1' });
    resolveFirst();
    await waitFor(() => extract.mock.calls.length === 2);
    service.schedule({ agentId: 'a', conversationId: 'c', runId: 't1' });
    resolveSecond();
    await service.flush();

    expect(extract).toHaveBeenCalledTimes(3);
  });

  it('runs a queued review rerun after the first pass fails', async () => {
    let rejectFirst: (error: Error) => void = () => {};
    const firstCall = new Promise<never[]>((_, reject) => {
      rejectFirst = reject;
    });
    const warn = vi.fn();
    const extract = vi
      .fn()
      .mockImplementationOnce(() => firstCall)
      .mockResolvedValue([]);
    const service = createSkillReviewService({
      conversations: fakeConversations(turnWith(5)),
      managedSkillsDir: () => dir,
      shouldReview: () => true,
      minToolCalls: () => 3,
      extract,
      logger: { info: vi.fn(), warn },
    });

    service.schedule({ agentId: 'a', conversationId: 'c', runId: 't1' });
    await waitFor(() => extract.mock.calls.length === 1);
    service.schedule({ agentId: 'a', conversationId: 'c', runId: 't1' });
    rejectFirst(new Error('first pass failed'));
    await service.flush();

    expect(extract).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(
      'skill review failed',
      expect.objectContaining({ error: 'first pass failed' }),
    );
  });
});

describe('the approval gate', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dash-skill-approval-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function gatedService(extract = vi.fn(async () => [ADD])) {
    return {
      extract,
      service: createSkillReviewService({
        conversations: fakeConversations(turnWith(5)),
        managedSkillsDir: () => dir,
        shouldReview: () => true,
        minToolCalls: () => 3,
        requiresApproval: () => true,
        extract,
      }),
    };
  }

  it('stages instead of writing when approval is required', async () => {
    const { service } = gatedService();

    service.schedule({ agentId: 'a', conversationId: 'c', runId: 't1' });
    await service.flush();

    expect(await listBooks(dir)).toEqual([]);

    const staged = await listPending(dir);
    expect(staged).toHaveLength(1);
    expect(staged[0].deltas).toEqual([ADD]);
    expect(staged[0].conversationId).toBe('c');
  });

  it('applying a staged proposal writes the lesson', async () => {
    const { service } = gatedService();
    service.schedule({ agentId: 'a', conversationId: 'c', runId: 't1' });
    await service.flush();

    const [staged] = await listPending(dir);
    const result = await applyPendingLessons(dir, staged.deltas);

    expect(result.created).toEqual(['build-lessons']);
    const books = await listBooks(dir);
    expect(books[0].bullets[0].text).toBe('Re-run the generator first.');
  });

  it('applying re-merges against the library as it is at approval time', async () => {
    const { service } = gatedService();
    service.schedule({ agentId: 'a', conversationId: 'c', runId: 't1' });
    await service.flush();
    const [staged] = await listPending(dir);

    // The same lesson lands by another route before approval happens.
    await applyPendingLessons(dir, staged.deltas);
    // Approving now must not create a duplicate — it counts as agreement.
    await applyPendingLessons(dir, staged.deltas);

    const books = await listBooks(dir);
    expect(books[0].bullets).toHaveLength(1);
    expect(books[0].bullets[0].helpful).toBe(1);
  });

  it('does not stage when the review found nothing', async () => {
    const { service } = gatedService(vi.fn(async () => []));

    service.schedule({ agentId: 'a', conversationId: 'c', runId: 't1' });
    await service.flush();

    expect(await listPending(dir)).toEqual([]);
  });
});

describe('existing skills are never overwritten', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dash-skill-reserved-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('drops a lesson that names an existing skill with no lesson book', async () => {
    const warn = vi.fn();
    const service = createSkillReviewService({
      conversations: fakeConversations(turnWith(5)),
      managedSkillsDir: () => dir,
      shouldReview: () => true,
      minToolCalls: () => 3,
      // The review proposes writing onto a plugin skill.
      extract: vi.fn(async () => [{ ...ADD, skill: 'dash-dev' }]),
      existingSkillNames: async () => ['dash-dev'],
      logger: { info: vi.fn(), warn },
    });

    service.schedule({ agentId: 'a', conversationId: 'c', runId: 't1' });
    await service.flush();

    expect(await listBooks(dir)).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      'skill review dropped a lesson',
      expect.objectContaining({ reason: expect.stringMatching(/existing skill/i) }),
    );
  });

  it('still learns when the proposed name is free', async () => {
    const service = createSkillReviewService({
      conversations: fakeConversations(turnWith(5)),
      managedSkillsDir: () => dir,
      shouldReview: () => true,
      minToolCalls: () => 3,
      extract: vi.fn(async () => [ADD]),
      existingSkillNames: async () => ['dash-dev'],
    });

    service.schedule({ agentId: 'a', conversationId: 'c', runId: 't1' });
    await service.flush();

    expect((await listBooks(dir)).map((b) => b.skill)).toEqual(['build-lessons']);
  });
});

describe('a correction is reviewed even below the effort gate', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dash-skill-correction-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function serviceFor(userText: string, toolCalls: number, extract = vi.fn(async () => [ADD])) {
    const specs = turnWith(toolCalls);
    specs[0] = { turnId: 't1', role: 'user', content: { type: 'user', text: userText } };
    return {
      extract,
      service: createSkillReviewService({
        conversations: fakeConversations(specs),
        managedSkillsDir: () => dir,
        shouldReview: () => true,
        minToolCalls: () => 3,
        extract,
      }),
    };
  }

  it('reviews a one-tool-call turn when the user corrected the agent', async () => {
    // The signal the feature exists for: corrections rarely run many tools, so
    // the tool-call gate alone would discard them.
    const { service, extract } = serviceFor('Stop using echo — always use printf here.', 1);

    service.schedule({ agentId: 'a', conversationId: 'c', runId: 't1' });
    await service.flush();

    expect(extract).toHaveBeenCalledTimes(1);
  });

  it('still skips a low-effort turn that is not a correction', async () => {
    const { service, extract } = serviceFor('What does this function do?', 1);

    service.schedule({ agentId: 'a', conversationId: 'c', runId: 't1' });
    await service.flush();

    expect(extract).not.toHaveBeenCalled();
  });
});
