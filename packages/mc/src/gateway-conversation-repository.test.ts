import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ConversationMessagePage,
  ConversationPage,
  ConversationSummary,
  MobileApiError,
  ReplayPage,
} from '@dash/mobile-contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConversationRepositoryOfflineError } from './conversation-repository.js';
import { GatewayConversationCache } from './gateway-conversation-cache.js';
import { GatewayConversationRepository } from './gateway-conversation-repository.js';
import { GatewayHttpError } from './runtime/gateway-client.js';

async function fixture<T>(name: string): Promise<T> {
  const url = new URL(`../../../contracts/mobile/v1/fixtures/${name}`, import.meta.url);
  return JSON.parse(await readFile(url, 'utf8')) as T;
}

function makeClient() {
  return {
    listConversations: vi.fn(),
    getConversation: vi.fn(),
    createConversation: vi.fn(),
    getConversationMessages: vi.fn(),
    patchConversation: vi.fn(),
    deleteConversation: vi.fn(),
    replayConversationEvents: vi.fn(),
  };
}

function tombstone(summary: ConversationSummary): ConversationSummary {
  return {
    ...summary,
    revision: summary.revision + 1,
    status: 'deleted',
    deletedAt: '2026-07-12T00:01:00.000Z',
  };
}

describe('GatewayConversationRepository', () => {
  let dataDir: string;
  let cache: GatewayConversationCache;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'gateway-conversation-repository-'));
    cache = new GatewayConversationCache(dataDir, 'gateway-1');
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('falls back to the same gateway cache for reads and blocks offline writes', async () => {
    const client = makeClient();
    const page = await fixture<ConversationPage>('conversations-page.json');
    client.listConversations.mockResolvedValueOnce(page);
    const repository = new GatewayConversationRepository('gateway-1', client, cache);
    await expect(repository.list({ limit: 50 })).resolves.toEqual(page);

    client.listConversations.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(repository.list({ limit: 50 })).resolves.toEqual(page);
    expect(repository.offline).toBe(true);
    await expect(repository.create('agent-1', 'request-1')).rejects.toThrow(
      'Gateway offline — cached conversations are read-only',
    );
    expect(client.createConversation).not.toHaveBeenCalled();
  });

  it.each([
    ['TypeError', () => new TypeError('fetch failed')],
    ['AbortError', () => new DOMException('aborted', 'AbortError')],
    ['TimeoutError', () => new DOMException('timed out', 'TimeoutError')],
  ])('uses cache only for the %s transport failure class', async (_name, makeFailure) => {
    const page = await fixture<ConversationPage>('conversations-page.json');
    await cache.putConversationPage(page, { limit: 50 });
    const client = makeClient();
    client.listConversations.mockRejectedValueOnce(makeFailure());
    const repository = new GatewayConversationRepository('gateway-1', client, cache);

    await expect(repository.list({ limit: 50 })).resolves.toEqual(page);
    expect(repository.offline).toBe(true);
  });

  it.each([
    ['HTTP 502', async () => new GatewayHttpError(502, 'listConversations', 'bad gateway')],
    [
      'structured gateway_offline',
      async () => {
        const apiError = await fixture<MobileApiError>('errors/gateway-offline.json');
        return new GatewayHttpError(503, 'listConversations', JSON.stringify(apiError), apiError);
      },
    ],
  ])('reads from cache and marks offline for %s', async (_name, makeFailure) => {
    const page = await fixture<ConversationPage>('conversations-page.json');
    await cache.putConversationPage(page, { limit: 50 });
    const client = makeClient();
    client.listConversations.mockRejectedValueOnce(await makeFailure());
    const repository = new GatewayConversationRepository('gateway-1', client, cache);

    await expect(repository.list({ limit: 50 })).resolves.toEqual(page);
    expect(repository.offline).toBe(true);
  });

  it.each([
    ['errors/unauthorized.json', 401],
    ['errors/revision-conflict.json', 409],
    ['errors/rate-limited.json', 429],
    ['errors/capability-required.json', 426],
  ])('keeps %s as a structured read failure', async (name, status) => {
    const apiError = await fixture<MobileApiError>(name);
    const failure = new GatewayHttpError(
      status,
      'listConversations',
      JSON.stringify(apiError),
      apiError,
    );
    const client = makeClient();
    client.listConversations.mockRejectedValueOnce(failure);
    const repository = new GatewayConversationRepository('gateway-1', client, cache);

    await expect(repository.list()).rejects.toBe(failure);
    expect(repository.offline).toBe(false);
  });

  it('keeps decode failures and mutation 404s structured', async () => {
    const client = makeClient();
    const repository = new GatewayConversationRepository('gateway-1', client, cache);
    const decode = new SyntaxError('invalid JSON');
    client.listConversations.mockRejectedValueOnce(decode);
    await expect(repository.list()).rejects.toBe(decode);
    expect(repository.offline).toBe(false);

    const apiError = await fixture<MobileApiError>('errors/not-found.json');
    const missing = new GatewayHttpError(
      404,
      'patchConversation',
      JSON.stringify(apiError),
      apiError,
    );
    client.patchConversation.mockRejectedValueOnce(missing);
    await expect(repository.rename('conv-1', 1, 'Missing')).rejects.toBe(missing);
    expect(repository.offline).toBe(false);
  });

  it('does not turn a revision conflict into an offline cache read', async () => {
    const apiError = await fixture<MobileApiError>('errors/revision-conflict.json');
    const conflict = new GatewayHttpError(
      409,
      'patchConversation',
      JSON.stringify(apiError),
      apiError,
    );
    const client = makeClient();
    client.patchConversation.mockRejectedValueOnce(conflict);
    const repository = new GatewayConversationRepository('gateway-1', client, cache);

    await expect(repository.rename('conv-1', 4, 'Manual')).rejects.toBe(conflict);
    expect(repository.offline).toBe(false);
  });

  it('treats detail 404 as canonical absence and purges all cached content', async () => {
    const page = await fixture<ConversationPage>('conversations-page.json');
    const messages = await fixture<ConversationMessagePage>('conversation-messages-page.json');
    const id = page.items[0].id;
    await cache.putConversationPage(page, { limit: 50 });
    await cache.putMessagePage(id, messages, { limit: 100 });
    const apiError = await fixture<MobileApiError>('errors/not-found.json');
    const missing = new GatewayHttpError(
      404,
      'getConversation',
      JSON.stringify(apiError),
      apiError,
    );
    const client = makeClient();
    client.getConversation.mockRejectedValueOnce(missing);
    const onDeleted = vi.fn();
    const repository = new GatewayConversationRepository('gateway-1', client, cache, onDeleted);

    await expect(repository.get(id)).resolves.toBeNull();
    await expect(cache.getConversation(id)).resolves.toBeNull();
    await expect(cache.getConversationPage({ limit: 50 })).resolves.toEqual({
      items: [],
      nextCursor: page.nextCursor,
    });
    await expect(cache.getMessagePage(id, { limit: 100 })).resolves.toEqual({
      items: [],
      nextCursor: null,
      throughSeq: 0,
    });
    expect(onDeleted).toHaveBeenCalledOnce();
    expect(onDeleted).toHaveBeenCalledWith({ id, origin: 'gateway' });
    expect(repository.offline).toBe(false);
  });

  it('purges a live tombstone and emits a gateway-origin deletion', async () => {
    const page = await fixture<ConversationPage>('conversations-page.json');
    const messages = await fixture<ConversationMessagePage>('conversation-messages-page.json');
    const id = page.items[0].id;
    await cache.putConversationPage(page, { limit: 50 });
    await cache.putMessagePage(id, messages);
    const client = makeClient();
    client.getConversation.mockResolvedValueOnce(tombstone(page.items[0]));
    const onDeleted = vi.fn();
    const repository = new GatewayConversationRepository('gateway-1', client, cache, onDeleted);

    await expect(repository.get(id)).resolves.toBeNull();
    await expect(cache.getConversation(id)).resolves.toBeNull();
    await expect(cache.getMessagePage(id)).resolves.toMatchObject({ items: [], throughSeq: 0 });
    expect(onDeleted).toHaveBeenCalledWith({ id, origin: 'gateway' });
  });

  it('purges a cached tombstone when the gateway is offline', async () => {
    const page = await fixture<ConversationPage>('conversations-page.json');
    const messages = await fixture<ConversationMessagePage>('conversation-messages-page.json');
    const deleted = tombstone(page.items[0]);
    await cache.putConversationPage({ items: [deleted], nextCursor: null }, { limit: 50 });
    await cache.putMessagePage(deleted.id, messages);
    const client = makeClient();
    client.getConversation.mockRejectedValueOnce(new TypeError('fetch failed'));
    const repository = new GatewayConversationRepository('gateway-1', client, cache);

    await expect(repository.get(deleted.id)).resolves.toBeNull();
    await expect(cache.getConversation(deleted.id)).resolves.toBeNull();
    await expect(cache.getMessagePage(deleted.id)).resolves.toMatchObject({
      items: [],
      throughSeq: 0,
    });
    expect(repository.offline).toBe(true);
  });

  it('persists a successful create into a first page for a new offline instance', async () => {
    const page = await fixture<ConversationPage>('conversations-page.json');
    const created = { ...page.items[0], id: 'created-conversation', title: 'Created' };
    const client = makeClient();
    client.listConversations.mockResolvedValueOnce(page);
    client.createConversation.mockResolvedValueOnce(created);
    const repository = new GatewayConversationRepository('gateway-1', client, cache);
    await repository.list({ limit: 50 });
    await expect(repository.create('agent-1', 'request-1')).resolves.toEqual(created);

    const offlineClient = makeClient();
    offlineClient.listConversations.mockRejectedValueOnce(new TypeError('fetch failed'));
    const reloaded = new GatewayConversationRepository(
      'gateway-1',
      offlineClient,
      new GatewayConversationCache(dataDir, 'gateway-1'),
    );
    const cached = await reloaded.list({ limit: 50 });
    expect(cached.items.map((item) => item.id)).toEqual(['created-conversation', page.items[0].id]);
    expect(reloaded.offline).toBe(true);
  });

  it('audits absent cached IDs and purges only canonical deletions after reconnect', async () => {
    const fixturePage = await fixture<ConversationPage>('conversations-page.json');
    const messages = await fixture<ConversationMessagePage>('conversation-messages-page.json');
    const deleted = { ...fixturePage.items[0], id: 'conv-deleted', title: 'Deleted remotely' };
    const offPage = { ...fixturePage.items[0], id: 'conv-off-page', title: 'Still live' };
    const visible = { ...fixturePage.items[0], id: 'conv-visible', title: 'Visible' };
    await cache.putConversationPage({ items: [deleted, offPage], nextCursor: null }, { limit: 50 });
    await cache.putConversationPage(
      { items: [deleted, offPage], nextCursor: null },
      { agentId: deleted.agentId, limit: 50 },
    );
    await cache.putMessagePage(deleted.id, messages, { limit: 100 });
    await cache.putMessagePage(offPage.id, messages, { limit: 100 });

    const client = makeClient();
    client.listConversations
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce({ items: [visible], nextCursor: null });
    client.getConversation.mockImplementation(async (id: string) => {
      if (id === deleted.id) return tombstone(deleted);
      if (id === offPage.id) return { ...offPage, revision: offPage.revision + 1 };
      throw new Error(`Unexpected audit id: ${id}`);
    });
    const onDeleted = vi.fn();
    const repository = new GatewayConversationRepository('gateway-1', client, cache, onDeleted);

    await expect(repository.list({ limit: 50 })).resolves.toEqual({
      items: [deleted, offPage],
      nextCursor: null,
    });
    expect(repository.offline).toBe(true);
    await expect(repository.list({ limit: 50 })).resolves.toEqual({
      items: [visible],
      nextCursor: null,
    });

    expect(client.getConversation).toHaveBeenCalledTimes(2);
    await expect(cache.getConversation(deleted.id)).resolves.toBeNull();
    await expect(cache.getMessagePage(deleted.id, { limit: 100 })).resolves.toMatchObject({
      items: [],
      throughSeq: 0,
    });
    await expect(cache.getConversation(offPage.id)).resolves.toMatchObject({
      id: offPage.id,
      revision: offPage.revision + 1,
    });
    await expect(cache.getMessagePage(offPage.id, { limit: 100 })).resolves.toEqual(messages);
    await expect(
      cache.getConversationPage({ agentId: deleted.agentId, limit: 50 }),
    ).resolves.toEqual({
      items: [{ ...offPage, revision: offPage.revision + 1 }],
      nextCursor: null,
    });
    expect(onDeleted).toHaveBeenCalledOnce();
    expect(onDeleted).toHaveBeenCalledWith({ id: deleted.id, origin: 'gateway' });
    expect(repository.offline).toBe(false);
  });

  it('reads messages online and uses the cached message fallback while offline', async () => {
    const page = await fixture<ConversationPage>('conversations-page.json');
    const messages = await fixture<ConversationMessagePage>('conversation-messages-page.json');
    const replay = await fixture<ReplayPage>('replay.json');
    const id = page.items[0].id;
    const client = makeClient();
    client.getConversationMessages
      .mockResolvedValueOnce(messages)
      .mockRejectedValueOnce(new TypeError('fetch failed'));
    client.replayConversationEvents.mockResolvedValueOnce(replay);
    const repository = new GatewayConversationRepository('gateway-1', client, cache);

    await expect(repository.messages(id, { limit: 100 })).resolves.toEqual(messages);
    await expect(repository.messages(id, { limit: 100 })).resolves.toEqual(messages);
    expect(repository.offline).toBe(true);
    await expect(repository.replay('agent-1', id, 2)).resolves.toEqual(replay.entries);
    expect(repository.offline).toBe(false);
  });

  it('surfaces an offline replay instead of silently replacing a gap with no entries', async () => {
    const client = makeClient();
    client.replayConversationEvents.mockRejectedValueOnce(
      new DOMException('aborted', 'AbortError'),
    );
    const repository = new GatewayConversationRepository('gateway-1', client, cache);

    await expect(repository.replay('agent-1', 'conversation-1', 2)).rejects.toBeInstanceOf(
      ConversationRepositoryOfflineError,
    );
    expect(repository.offline).toBe(true);
  });

  it('caches patches, linkage, and explicit delete tombstones', async () => {
    const page = await fixture<ConversationPage>('conversations-page.json');
    const original = page.items[0];
    await cache.putConversationPage(page, { limit: 50 });
    const renamed = { ...original, title: 'Renamed', revision: original.revision + 1 };
    const linked = { ...renamed, owningIssueId: 'issue-2', revision: renamed.revision + 1 };
    const deleted = tombstone(linked);
    const client = makeClient();
    client.patchConversation.mockResolvedValueOnce(renamed).mockResolvedValueOnce(linked);
    client.deleteConversation.mockResolvedValueOnce(deleted);
    const repository = new GatewayConversationRepository('gateway-1', client, cache);

    await expect(repository.rename(original.id, original.revision, 'Renamed')).resolves.toEqual(
      renamed,
    );
    await expect(
      repository.setLinkage(original.id, renamed.revision, { owningIssueId: 'issue-2' }),
    ).resolves.toEqual(linked);
    await expect(repository.delete(original.id, linked.revision)).resolves.toEqual(deleted);
    expect(client.patchConversation).toHaveBeenNthCalledWith(1, original.id, original.revision, {
      title: 'Renamed',
    });
    expect(client.patchConversation).toHaveBeenNthCalledWith(2, original.id, renamed.revision, {
      owningIssueId: 'issue-2',
    });
    await expect(cache.getConversation(original.id)).resolves.toBeNull();
  });

  it('invalidates cached content only for deletion events', async () => {
    const page = await fixture<ConversationPage>('conversations-page.json');
    const id = page.items[0].id;
    await cache.putConversationPage(page, { limit: 50 });
    const repository = new GatewayConversationRepository('gateway-1', makeClient(), cache);

    await repository.invalidate(id, false);
    await expect(cache.getConversation(id)).resolves.toEqual(page.items[0]);
    await repository.invalidate(id, true);
    await expect(cache.getConversation(id)).resolves.toBeNull();
  });

  it('wraps mutation transport failure in the repository offline error', async () => {
    const client = makeClient();
    client.createConversation.mockRejectedValueOnce(new TypeError('fetch failed'));
    const repository = new GatewayConversationRepository('gateway-1', client, cache);

    await expect(repository.create('agent-1', 'request-1')).rejects.toBeInstanceOf(
      ConversationRepositoryOfflineError,
    );
    expect(repository.offline).toBe(true);
  });
});
