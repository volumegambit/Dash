import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LessonDelta } from '@dash/agent';
import { listBooks } from '@dash/agent';
import type {
  ConversationContent,
  ConversationMessage,
  ConversationRole,
} from '@dash/mobile-contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationService } from './conversation-service.js';
import type { SkillReviewOptions } from './skill-review.js';
import { createSkillReviewService } from './skill-review.js';

interface MessageSpec {
  turnId: string;
  role: ConversationRole;
  content: ConversationContent;
}

function fakeConversations(specs: MessageSpec[]): Pick<ConversationService, 'listMessages'> {
  const items: ConversationMessage[] = specs.map((spec, i) => ({
    id: `m${i}`,
    conversationId: 'c',
    turnId: spec.turnId,
    ordinal: i,
    role: spec.role,
    status: 'completed',
    content: spec.content,
    createdAt: '2026-09-06T00:00:00.000Z',
    updatedAt: '2026-09-06T00:00:00.000Z',
  }));
  return {
    listMessages: () => ({ items, nextCursor: null, throughSeq: items.length }),
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

    service.schedule({ agentId: 'a', conversationId: 'c', turnId: 't1' });
    await service.flush();

    expect(extract).toHaveBeenCalledTimes(1);

    const books = await listBooks(dir);
    expect(books).toHaveLength(1);
    expect(books[0].skill).toBe('build-lessons');
    expect(books[0].bullets[0].text).toBe('Re-run the generator first.');

    const md = await readFile(join(dir, 'build-lessons', 'SKILL.md'), 'utf-8');
    expect(md).toContain('Re-run the generator first.');
  });

  it('does not call the model for a turn below the effort gate', async () => {
    const { service, extract } = makeService({}, 2);

    service.schedule({ agentId: 'a', conversationId: 'c', turnId: 't1' });
    await service.flush();

    expect(extract).not.toHaveBeenCalled();
    expect(await listBooks(dir)).toEqual([]);
  });

  it('reviews exactly at the effort gate', async () => {
    const { service, extract } = makeService({}, 3);

    service.schedule({ agentId: 'a', conversationId: 'c', turnId: 't1' });
    await service.flush();

    expect(extract).toHaveBeenCalledTimes(1);
  });

  it('does nothing when learning is off for the agent', async () => {
    const { service, extract } = makeService({ shouldReview: () => false });

    service.schedule({ agentId: 'a', conversationId: 'c', turnId: 't1' });
    await service.flush();

    expect(extract).not.toHaveBeenCalled();
  });

  it('does nothing when the agent has no managed skills directory', async () => {
    const { service, extract } = makeService({ managedSkillsDir: () => null });

    service.schedule({ agentId: 'a', conversationId: 'c', turnId: 't1' });
    await service.flush();

    expect(extract).not.toHaveBeenCalled();
  });

  it('does nothing for an unknown turn', async () => {
    const { service, extract } = makeService();

    service.schedule({ agentId: 'a', conversationId: 'c', turnId: 'no-such-turn' });
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

    service.schedule({ agentId: 'a', conversationId: 'c', turnId: 't1' });
    await service.flush();

    expect(extract.mock.calls[0][0]).toMatchObject({ loadedSkills: ['dash-dev'] });
  });

  it('passes the books the agent already holds so lessons can be marked', async () => {
    const { service } = makeService();
    service.schedule({ agentId: 'a', conversationId: 'c', turnId: 't1' });
    await service.flush();

    const extract = vi.fn(async () => []);
    const second = createSkillReviewService({
      conversations: fakeConversations(turnWith(5)),
      managedSkillsDir: () => dir,
      shouldReview: () => true,
      minToolCalls: () => 3,
      extract,
    });
    second.schedule({ agentId: 'a', conversationId: 'c', turnId: 't1' });
    await second.flush();

    const books = extract.mock.calls[0][0].books;
    expect(books).toHaveLength(1);
    expect(books[0].skill).toBe('build-lessons');
  });

  it('reports what was learned', async () => {
    const onLearned = vi.fn();
    const { service } = makeService({ onLearned });

    service.schedule({ agentId: 'a', conversationId: 'c', turnId: 't1' });
    await service.flush();

    expect(onLearned).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'a', created: ['build-lessons'] }),
    );
  });

  it('does not report when the review found nothing', async () => {
    const onLearned = vi.fn();
    const { service } = makeService({ onLearned, extract: vi.fn(async () => []) });

    service.schedule({ agentId: 'a', conversationId: 'c', turnId: 't1' });
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
      service.schedule({ agentId: 'a', conversationId: 'c', turnId: 't1' }),
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

    service.schedule({ agentId: 'a', conversationId: 'c', turnId: 't1' });
    service.schedule({ agentId: 'a', conversationId: 'c', turnId: 't1' });
    service.schedule({ agentId: 'a', conversationId: 'c', turnId: 't1' });
    await service.flush();
    await waitFor(() => running === 0);

    expect(maxConcurrent).toBe(1);
    // Three schedules, one in flight plus a single coalesced rerun.
    expect(extract).toHaveBeenCalledTimes(2);
  });
});
