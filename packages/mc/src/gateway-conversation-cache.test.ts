import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ConversationMessagePage,
  ConversationPage,
  ConversationSummary,
} from '@dash/mobile-contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GatewayConversationCache } from './gateway-conversation-cache.js';

async function fixture<T>(name: string): Promise<T> {
  const url = new URL(`../../../contracts/mobile/v1/fixtures/${name}`, import.meta.url);
  return JSON.parse(await readFile(url, 'utf8')) as T;
}

function conversation(id: string, agentId = 'agent-1', title = id): ConversationSummary {
  return {
    id,
    agentId,
    agentName: agentId === 'agent-1' ? 'Developer' : 'Other',
    title,
    revision: 1,
    status: 'idle',
    activeTurnId: null,
    owningIssueId: null,
    projectId: null,
    lastSeq: 0,
    lastMessagePreview: '',
    createdAt: '2026-07-12T00:00:00Z',
    updatedAt: '2026-07-12T00:00:00Z',
  };
}

describe('GatewayConversationCache', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'gateway-conversation-cache-'));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('never exposes one gateway cache through another gateway identity', async () => {
    const first = new GatewayConversationCache(dataDir, 'gateway-A');
    const second = new GatewayConversationCache(dataDir, 'gateway-B');
    const page = {
      items: [conversation('conv-A', 'agent-1', 'A only')],
      nextCursor: null,
    } satisfies ConversationPage;

    await first.putConversationPage(page, { limit: 50 });
    await expect(first.getConversationPage({ limit: 50 })).resolves.toEqual(page);
    await expect(
      new GatewayConversationCache(dataDir, 'gateway-A').getConversationIds(),
    ).resolves.toEqual(['conv-A']);
    await expect(second.getConversationPage({ limit: 50 })).resolves.toEqual({
      items: [],
      nextCursor: null,
    });
  });

  it('stores canonical transcript pages and removes deleted content', async () => {
    const cache = new GatewayConversationCache(dataDir, '../unsafe/gateway');
    const messages = await fixture<ConversationMessagePage>('conversation-messages-page.json');
    await cache.putConversationPage(
      { items: [conversation('conv-1')], nextCursor: null },
      { limit: 50 },
    );
    await cache.putMessagePage('conv-1', messages);
    await expect(cache.getMessagePage('conv-1')).resolves.toEqual(messages);
    await cache.removeConversation('conv-1');
    await expect(cache.getConversation('conv-1')).resolves.toBeNull();
    await expect(cache.getConversationPage({ limit: 50 })).resolves.toEqual({
      items: [],
      nextCursor: null,
    });
    await expect(cache.getMessagePage('conv-1')).resolves.toEqual({
      items: [],
      nextCursor: null,
      throughSeq: 0,
    });

    const entries = await readFile(join(dataDir, 'gateway-conversations', 'index.json'), 'utf8');
    expect(entries).toContain('../unsafe/gateway');
    expect(entries).not.toContain('managementToken');
    expect(entries).not.toContain('chatToken');
  });

  it('serializes writes across cache instances and preserves both gateway index entries', async () => {
    const firstA = new GatewayConversationCache(dataDir, 'gateway-A');
    const secondA = new GatewayConversationCache(dataDir, 'gateway-A');
    const gatewayB = new GatewayConversationCache(dataDir, 'gateway-B');
    let arrived = 0;
    let releaseWrites = (): void => {};
    let markAllArrived = (): void => {};
    const release = new Promise<void>((resolve) => {
      releaseWrites = resolve;
    });
    const allArrived = new Promise<void>((resolve) => {
      markAllArrived = resolve;
    });
    const blockWrite = (cache: GatewayConversationCache): void => {
      const putConversation = cache.putConversation.bind(cache);
      cache.putConversation = async (item) => {
        arrived += 1;
        if (arrived === 3) markAllArrived();
        await release;
        return putConversation(item);
      };
    };
    blockWrite(firstA);
    blockWrite(secondA);
    blockWrite(gatewayB);

    const writes = [
      firstA.putConversation(conversation('conv-A-1')),
      secondA.putConversation(conversation('conv-A-2')),
      gatewayB.putConversation(conversation('conv-B-1', 'agent-2')),
    ];
    await allArrived;
    expect(arrived).toBe(3);
    releaseWrites();
    await Promise.all(writes);

    await expect(
      new GatewayConversationCache(dataDir, 'gateway-A').getConversationIds(),
    ).resolves.toEqual(['conv-A-1', 'conv-A-2']);
    await expect(
      new GatewayConversationCache(dataDir, 'gateway-B').getConversationIds(),
    ).resolves.toEqual(['conv-B-1']);
    const index = JSON.parse(
      await readFile(join(dataDir, 'gateway-conversations', 'index.json'), 'utf8'),
    ) as { gateways: Record<string, string> };
    expect(Object.values(index.gateways).sort()).toEqual(['gateway-A', 'gateway-B']);
  });

  it('releases the shared write chain after a rejected operation', async () => {
    const cache = new GatewayConversationCache(dataDir, 'gateway-A');
    const invalid = conversation('invalid') as ConversationSummary & { circular?: unknown };
    invalid.circular = invalid;

    await expect(cache.putConversation(invalid)).rejects.toThrow();
    await expect(cache.putConversation(conversation('valid'))).resolves.toBeUndefined();
    await expect(cache.getConversationIds()).resolves.toEqual(['valid']);
  });

  it('keeps message pages with distinct limits under distinct keys', async () => {
    const cache = new GatewayConversationCache(dataDir, 'gateway-A');
    const fixturePage = await fixture<ConversationMessagePage>('conversation-messages-page.json');
    const fifty = { ...fixturePage, throughSeq: 50 };
    const hundred = { ...fixturePage, throughSeq: 100 };

    await cache.putMessagePage('conv-1', fifty, { limit: 50, before: 'cursor-1' });
    await cache.putMessagePage('conv-1', hundred, { limit: 100, before: 'cursor-1' });

    await expect(
      cache.getMessagePage('conv-1', { limit: 50, before: 'cursor-1' }),
    ).resolves.toEqual(fifty);
    await expect(
      cache.getMessagePage('conv-1', { limit: 100, before: 'cursor-1' }),
    ).resolves.toEqual(hundred);
  });

  it('prepends creates only to matching first pages and invalidates their continuations', async () => {
    const cache = new GatewayConversationCache(dataDir, 'gateway-A');
    const created = conversation('conv-new', 'agent-1', 'Created');
    const first = conversation('conv-first', 'agent-1', 'First');
    const continuation = conversation('conv-continuation', 'agent-1', 'Continuation');
    const unrelated = conversation('conv-unrelated', 'agent-2', 'Unrelated');

    await cache.putConversationPage(
      { items: [first, created], nextCursor: 'unfiltered-next' },
      { limit: 2 },
    );
    await cache.putConversationPage(
      { items: [continuation], nextCursor: null },
      { limit: 2, cursor: 'unfiltered-next' },
    );
    await cache.putConversationPage(
      { items: [first], nextCursor: 'agent-next' },
      { agentId: 'agent-1', limit: 1 },
    );
    await cache.putConversationPage(
      { items: [continuation], nextCursor: null },
      { agentId: 'agent-1', limit: 1, cursor: 'agent-next' },
    );
    await cache.putConversationPage(
      { items: [unrelated], nextCursor: 'other-next' },
      { agentId: 'agent-2', limit: 1 },
    );
    await cache.putConversationPage(
      { items: [unrelated], nextCursor: null },
      { agentId: 'agent-2', limit: 1, cursor: 'other-next' },
    );

    await cache.putCreatedConversation(created);

    await expect(cache.getConversationPage({ limit: 2 })).resolves.toEqual({
      items: [created, first],
      nextCursor: null,
    });
    await expect(
      cache.getConversationPage({ limit: 2, cursor: 'unfiltered-next' }),
    ).resolves.toEqual({ items: [], nextCursor: null });
    await expect(cache.getConversationPage({ agentId: 'agent-1', limit: 1 })).resolves.toEqual({
      items: [created],
      nextCursor: null,
    });
    await expect(
      cache.getConversationPage({ agentId: 'agent-1', limit: 1, cursor: 'agent-next' }),
    ).resolves.toEqual({ items: [], nextCursor: null });
    await expect(cache.getConversationPage({ agentId: 'agent-2', limit: 1 })).resolves.toEqual({
      items: [unrelated],
      nextCursor: 'other-next',
    });
    await expect(
      cache.getConversationPage({ agentId: 'agent-2', limit: 1, cursor: 'other-next' }),
    ).resolves.toEqual({ items: [unrelated], nextCursor: null });

    const refreshed = { items: [created, first], nextCursor: 'server-next' };
    await cache.putConversationPage(refreshed, { limit: 2 });
    const reloaded = new GatewayConversationCache(dataDir, 'gateway-A');
    await expect(reloaded.getConversationPage({ limit: 2 })).resolves.toEqual(refreshed);
    await expect(reloaded.getConversationIds()).resolves.toEqual(
      ['conv-continuation', 'conv-first', 'conv-new', 'conv-unrelated'].sort(),
    );
  });
});
