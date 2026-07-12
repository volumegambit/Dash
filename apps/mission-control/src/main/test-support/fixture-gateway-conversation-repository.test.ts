import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConversationRepositoryOfflineError, GatewayHttpError } from '@dash/mc';
import type {
  ConversationMessagePage,
  ConversationPage,
  MobileApiError,
  ReplayPage,
} from '@dash/mobile-contract';
import { beforeEach, describe, expect, it } from 'vitest';
import { FixtureGatewayConversationRepository } from './fixture-gateway-conversation-repository.js';

async function fixture<T>(name: string): Promise<T> {
  const root = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../../../../contracts/mobile/v1/fixtures',
  );
  return JSON.parse(await readFile(resolve(root, name), 'utf8')) as T;
}

describe('FixtureGatewayConversationRepository', () => {
  let repository: FixtureGatewayConversationRepository;

  beforeEach(async () => {
    repository = await FixtureGatewayConversationRepository.load();
  });

  it('serves frozen list, transcript, and replay fixtures byte-for-byte', async () => {
    const conversations = await fixture<ConversationPage>('conversations-page.json');
    const messages = await fixture<ConversationMessagePage>('conversation-messages-page.json');
    const replay = await fixture<ReplayPage>('replay.json');
    const id = conversations.items[0].id;

    await expect(repository.list({ limit: 50 })).resolves.toEqual(conversations);
    await expect(repository.get(id)).resolves.toEqual(conversations.items[0]);
    await expect(repository.messages(id)).resolves.toEqual(messages);
    await expect(repository.replay('agent-01', id, 0)).resolves.toEqual(replay.entries);
    await expect(repository.replay('agent-01', id, 2)).resolves.toEqual(
      replay.entries.filter((entry) => entry.seq > 2),
    );
    expect(repository.calls).toEqual([
      { method: 'list', args: [{ limit: 50 }] },
      { method: 'get', args: [id] },
      { method: 'messages', args: [id] },
      { method: 'replay', args: ['agent-01', id, 0] },
      { method: 'replay', args: ['agent-01', id, 2] },
    ]);
  });

  it.each([
    ['errors/unauthorized.json', 401],
    ['errors/not-found.json', 404],
    ['errors/validation-failed.json', 400],
    ['errors/revision-conflict.json', 409],
    ['errors/conversation-busy.json', 409],
    ['errors/rate-limited.json', 429],
    ['errors/gateway-offline.json', 502],
    ['errors/capability-required.json', 426],
  ])('maps %s to HTTP %i without changing structured fields', async (name, status) => {
    const apiError = await fixture<MobileApiError>(name);
    repository.failWith(apiError);

    const failure = await repository
      .create('agent-01', 'request-01')
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(GatewayHttpError);
    expect(failure).toMatchObject({
      status,
      apiError: {
        code: apiError.code,
        retryable: apiError.retryable,
      },
    });
    expect((failure as GatewayHttpError).apiError).toEqual(apiError);
  });

  it('clears injected failures and records canonical mutation calls', async () => {
    const conversations = await fixture<ConversationPage>('conversations-page.json');
    const id = conversations.items[0].id;
    const apiError = await fixture<MobileApiError>('errors/revision-conflict.json');
    repository.failWith(apiError);
    await expect(repository.create('agent-01', 'request-01')).rejects.toBeInstanceOf(
      GatewayHttpError,
    );

    repository.failWith(null);
    await expect(repository.create('agent-01', 'request-01')).resolves.toEqual(
      conversations.items[0],
    );
    await expect(repository.rename(id, 2, 'Renamed')).resolves.toMatchObject({
      id,
      title: 'Renamed',
      revision: 3,
    });
    await expect(
      repository.setLinkage(id, 3, { owningIssueId: 'issue-2', projectId: null }),
    ).resolves.toMatchObject({
      id,
      owningIssueId: 'issue-2',
      projectId: null,
      revision: 4,
    });
    await expect(repository.delete(id, 4)).resolves.toMatchObject({
      id,
      status: 'deleted',
      revision: 5,
      deletedAt: '2026-07-12T00:00:00Z',
    });
    expect(repository.calls).toEqual(
      expect.arrayContaining([
        { method: 'create', args: ['agent-01', 'request-01'] },
        { method: 'rename', args: [id, 2, 'Renamed'] },
        { method: 'patch', args: [id, 2, { title: 'Renamed' }] },
        {
          method: 'setLinkage',
          args: [id, 3, { owningIssueId: 'issue-2', projectId: null }],
        },
        {
          method: 'patch',
          args: [id, 3, { owningIssueId: 'issue-2', projectId: null }],
        },
        { method: 'delete', args: [id, 4] },
      ]),
    );
  });

  it('blocks mutations while offline while leaving frozen reads available', async () => {
    const conversations = await fixture<ConversationPage>('conversations-page.json');
    repository.setOffline(true);

    await expect(repository.list()).resolves.toEqual(conversations);
    await expect(repository.create('agent-01', 'request-01')).rejects.toBeInstanceOf(
      ConversationRepositoryOfflineError,
    );
    expect(repository.calls).toEqual([{ method: 'list', args: [{}] }]);
  });
});
