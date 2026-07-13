import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConversationSummary } from '@dash/mobile-contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConversationStore } from './conversations.js';
import { LegacyConversationRepository } from './legacy-conversation-repository.js';

describe('LegacyConversationRepository', () => {
  let dataDir: string;
  let store: ConversationStore;
  let repository: LegacyConversationRepository;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'legacy-conversation-repository-'));
    store = new ConversationStore(dataDir);
    repository = new LegacyConversationRepository(store, (agentId) =>
      agentId === 'agent-1' ? 'Developer' : agentId,
    );
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('maps existing local records without rewriting their files', async () => {
    const local = await store.create('agent-1');
    await store.appendMessage(local.id, {
      id: 'local-user-1',
      role: 'user',
      content: { type: 'user', text: 'kept on this Mac' },
      timestamp: '2026-07-12T00:00:00.000Z',
    });
    const indexPath = join(dataDir, 'conversations', 'index.json');
    const messagesPath = join(dataDir, 'conversations', `${local.id}.jsonl`);
    const indexBefore = await readFile(indexPath);
    const messagesBefore = await readFile(messagesPath);

    const page = await repository.list({ limit: 50 });
    const found = await repository.get(local.id);
    const messages = await repository.messages(local.id, { limit: 100 });

    expect(repository.offline).toBe(false);
    expect(page.nextCursor).toBeNull();
    expect(page.items[0]).toMatchObject({
      id: local.id,
      agentId: 'agent-1',
      agentName: 'Developer',
      title: 'kept on this Mac',
      revision: 0,
      status: 'idle',
      activeTurnId: null,
    });
    expect(found).toEqual(page.items[0]);
    expect(messages.items[0]).toMatchObject({
      id: 'local-user-1',
      conversationId: local.id,
      turnId: 'legacy:local-user-1',
      role: 'user',
      status: 'completed',
      ordinal: 1,
    });
    expect(await readFile(indexPath)).toEqual(indexBefore);
    expect(await readFile(messagesPath)).toEqual(messagesBefore);
  });

  it('writes only through ConversationStore in legacy mode', async () => {
    const appendSpy = vi.spyOn(store, 'appendMessage');
    const created = await repository.create('agent-1', 'ignored-request-id');
    await repository.rename(created.id, 0, 'Local title');
    await repository.setLinkage(created.id, 0, { owningIssueId: 'issue-1' });

    expect((await store.get(created.id))?.title).toBe('Local title');
    expect((await store.get(created.id))?.issueId).toBe('issue-1');
    expect(appendSpy).not.toHaveBeenCalled();
  });

  it('maps supported images and discriminated assistant events without mutating legacy bytes', async () => {
    const local = await store.create('agent-1');
    await store.appendMessage(local.id, {
      id: 'local-user-images',
      role: 'user',
      content: {
        type: 'user',
        text: 'images',
        images: [
          { mediaType: 'image/jpeg', data: 'jpeg' },
          { mediaType: 'image/png', data: 'png' },
          { mediaType: 'image/gif', data: 'gif' },
          { mediaType: 'image/webp', data: 'webp' },
          { mediaType: 'image/tiff', data: 'unsupported' },
        ],
      },
      timestamp: '2026-07-12T00:00:01.000Z',
    });
    await store.appendMessage(local.id, {
      id: 'local-assistant-events',
      role: 'assistant',
      content: {
        type: 'assistant',
        events: [
          { type: 'text_delta', text: 'hello' },
          { type: 42, text: 'malformed discriminator' },
          { text: 'missing discriminator' },
        ],
      },
      timestamp: '2026-07-12T00:00:02.000Z',
    });
    const indexPath = join(dataDir, 'conversations', 'index.json');
    const messagesPath = join(dataDir, 'conversations', `${local.id}.jsonl`);
    const indexBefore = await readFile(indexPath);
    const messagesBefore = await readFile(messagesPath);

    const messages = await repository.messages(local.id);

    expect(messages.items[0].content).toEqual({
      type: 'user',
      text: 'images',
      images: [
        { mediaType: 'image/jpeg', data: 'jpeg' },
        { mediaType: 'image/png', data: 'png' },
        { mediaType: 'image/gif', data: 'gif' },
        { mediaType: 'image/webp', data: 'webp' },
      ],
    });
    expect(messages.items[1].content).toEqual({
      type: 'assistant',
      events: [{ type: 'text_delta', text: 'hello' }],
    });
    expect(await readFile(indexPath)).toEqual(indexBefore);
    expect(await readFile(messagesPath)).toEqual(messagesBefore);
  });

  it('applies supported create metadata before returning the canonical summary', async () => {
    const renameSpy = vi.spyOn(store, 'rename');
    const setIssueSpy = vi.spyOn(store, 'setIssueId');

    const created = await repository.create('agent-1', 'request-1', {
      title: 'Created title',
      owningIssueId: 'issue-1',
      projectId: 'gateway-only-project',
    });

    expect(renameSpy).toHaveBeenCalledWith(created.id, 'Created title');
    expect(setIssueSpy).toHaveBeenCalledWith(created.id, 'issue-1');
    expect(created).toMatchObject({
      title: 'Created title',
      owningIssueId: 'issue-1',
      projectId: null,
    });
    expect(await store.get(created.id)).toMatchObject({
      title: 'Created title',
      issueId: 'issue-1',
    });
  });

  it('ignores nullable and gateway-only create linkage instead of changing the legacy schema', async () => {
    const setIssueSpy = vi.spyOn(store, 'setIssueId');

    const created = await repository.create('agent-1', 'request-2', {
      owningIssueId: null,
      projectId: 'gateway-only-project',
    });

    expect(setIssueSpy).not.toHaveBeenCalled();
    expect(created.owningIssueId).toBeNull();
    expect(created.projectId).toBeNull();
    expect(await store.get(created.id)).not.toHaveProperty('projectId');
  });

  it('returns a tombstone on delete and no replay entries for local conversations', async () => {
    const created = await repository.create('agent-1', 'request-3');
    await store.appendMessage(created.id, {
      id: 'local-user-delete',
      role: 'user',
      content: { type: 'user', text: 'delete me' },
      timestamp: '2026-07-12T00:00:03.000Z',
    });

    const deleted = await repository.delete(created.id, 0);

    expect(deleted).toMatchObject({ id: created.id, status: 'deleted' });
    expect(deleted.deletedAt).toEqual(expect.any(String));
    expect(await repository.get(created.id)).toBeNull();
    expect(await store.getMessages(created.id)).toEqual([]);
    await expect(repository.replay('agent-1', created.id, 0)).resolves.toEqual([]);
  });

  it('throws when a legacy patch targets a missing conversation', async () => {
    await expect(
      repository.patch('missing', 0, { title: 'Does not exist' }),
    ).rejects.toThrow('Conversation "missing" not found');
  });

  it('exposes canonical metadata types without adding a legacy field', async () => {
    const metadata: Partial<
      Pick<ConversationSummary, 'title' | 'owningIssueId' | 'projectId'>
    > = { projectId: 'gateway-only-project' };

    const created = await repository.create('agent-1', 'request-4', metadata);

    expect(created.projectId).toBeNull();
    expect(await store.get(created.id)).not.toHaveProperty('projectId');
  });
});
