import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type {
  ConversationMessage,
  ConversationMessagePage,
  MobileWsServerFrame,
} from '@dash/mobile-contract';
import { describe, expect, it } from 'vitest';
import {
  applySequencedFrame,
  mergeCanonicalMessages,
  replaceAcceptedOptimisticMessage,
} from './chat-sync.js';

const fixtures = resolve(process.cwd(), 'contracts/mobile/v1/fixtures');

async function fixture<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(resolve(fixtures, name), 'utf8')) as T;
}

async function jsonl<T>(name: string): Promise<T[]> {
  return (await readFile(resolve(fixtures, name), 'utf8'))
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

describe('canonical chat synchronization', () => {
  it('replaces the optimistic user ID with the accepted canonical ID by turn and role', async () => {
    const accepted =
      await fixture<Extract<MobileWsServerFrame, { type: 'accepted' }>>('chat-accepted.json');
    const optimistic: ConversationMessage = {
      id: `optimistic:${accepted.id}`,
      conversationId: accepted.conversationId,
      turnId: accepted.id,
      ordinal: Number.MAX_SAFE_INTEGER,
      role: 'user',
      status: 'accepted',
      content: { type: 'user', text: 'hello' },
      createdAt: '2026-07-12T00:00:00Z',
      updatedAt: '2026-07-12T00:00:00Z',
    };

    expect(replaceAcceptedOptimisticMessage([optimistic], accepted)[0]).toMatchObject({
      id: accepted.userMessageId,
      turnId: accepted.id,
      role: 'user',
    });
  });

  it('merges transcript refreshes by canonical ID and removes the optimistic duplicate', async () => {
    const page = await fixture<ConversationMessagePage>('conversation-messages-page.json');
    const duplicate = { ...page.items[0], updatedAt: '2026-07-12T01:00:00Z' };
    const merged = mergeCanonicalMessages(
      [{ ...page.items[0], content: { type: 'user', text: 'stale' } }, page.items[1]],
      [duplicate],
    );

    expect(merged).toHaveLength(2);
    expect(merged.find((item) => item.id === duplicate.id)?.updatedAt).toBe(duplicate.updatedAt);
  });

  it('ignores duplicate seq and identifies a gap without applying the later frame', async () => {
    const frames = await jsonl<MobileWsServerFrame>('chat-stream.jsonl');
    const first = applySequencedFrame({ lastSeq: 0, frames: [] }, frames[0]);
    const duplicate = applySequencedFrame(first.state, frames[0]);
    const gap = applySequencedFrame(first.state, frames[2]);

    expect(duplicate).toEqual({ state: first.state, gapAfter: null });
    expect(gap).toEqual({ state: first.state, gapAfter: first.state.lastSeq });
  });

  it('preserves an unknown event object unchanged', () => {
    const frame: MobileWsServerFrame = {
      type: 'event',
      id: 'turn-future',
      conversationId: 'conversation-1',
      seq: 1,
      event: { type: 'future_event', opaque: { version: 2 } },
    };

    const result = applySequencedFrame({ lastSeq: 0, frames: [] }, frame);

    expect(result.state.frames).toEqual([frame]);
    expect(result.state.frames[0]).toBe(frame);
  });

  it('uses the canonical assistant ID from a terminal transcript refresh', async () => {
    const page = await fixture<ConversationMessagePage>('conversation-messages-page.json');
    const canonicalAssistant = page.items.find((message) => message.role === 'assistant');
    if (!canonicalAssistant) throw new Error('Fixture is missing its assistant message');
    const optimisticAssistant: ConversationMessage = {
      ...canonicalAssistant,
      id: `optimistic:${canonicalAssistant.turnId}`,
      ordinal: Number.MAX_SAFE_INTEGER,
      status: 'streaming',
    };

    const merged = mergeCanonicalMessages([optimisticAssistant], page.items);
    const assistants = merged.filter((message) => message.role === 'assistant');

    expect(assistants).toHaveLength(1);
    expect(assistants[0].id).toBe(canonicalAssistant.id);
  });
});
