import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ConversationStore,
  GatewayConversationCache,
  GatewayConversationRepository,
  GatewayHttpError,
  LegacyConversationRepository,
} from '@dash/mc';
import type { ConversationRef, McConversationView } from '@dash/mc';
import type {
  ConversationMessage,
  ConversationMessagePage,
  ConversationPage,
  ConversationSummary,
  MobileApiError,
  MobileWsClientFrame,
  MobileWsServerFrame,
  ReplayPage,
} from '@dash/mobile-contract';
import { cleanup, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockApi } from '../../vitest.setup.js';
import { MessageBubble } from '../renderer/src/routes/chat.js';
import { useChatStore } from '../renderer/src/stores/chat.js';
import { captureChatIpcResult, unwrapChatIpcResult } from '../shared/ipc.js';
import { ChatService } from './chat-service.js';
import { ConversationController } from './conversation-controller.js';
import { createCanonicalChatHandlers, parseConversationInvalidations } from './ipc.js';
import {
  type ChatSocket,
  type ChatSocketEvent,
  ResumableChatTransport,
} from './resumable-chat-transport.js';

vi.mock('ws', () => {
  class ListenerFreeWebSocket {
    static readonly OPEN = 1;
    readyState = 0;
    addEventListener(): void {}
    send(): void {}
    close(): void {
      this.readyState = 3;
    }
  }
  return { default: ListenerFreeWebSocket };
});

const fixturesRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../contracts/mobile/v1/fixtures',
);

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('Mission Control mobile-v1 conversation sync', () => {
  it('adopts a capable gateway without touching legacy files', async () => {
    const harness = await createConversationSyncHarness({ capability: 'capable' });
    const before = await harness.readLegacyDirectory();
    const list = await harness.chat.listConversations();
    expect(list.items.some((item: { origin: string }) => item.origin === 'gateway')).toBe(true);
    expect(
      list.items.some(
        (item: { origin: string; readOnly: boolean }) => item.origin === 'local' && item.readOnly,
      ),
    ).toBe(true);

    const created = await harness.chat.createConversation('agent-1', 'create-request-1');
    const accepted = await harness.sendAndAccept(
      { id: created.id, origin: 'gateway' },
      'turn-request-1',
      'ship the sync',
    );
    expect(accepted).toEqual({
      ...(await harness.fixture('chat-accepted.json')),
      id: 'turn-request-1',
    });
    expect(await harness.readLegacyDirectory()).toEqual(before);
  });

  it('replays, resumes, answers, and explicitly cancels one canonical turn', async () => {
    const harness = await createConversationSyncHarness({ capability: 'capable' });
    await harness.startFrozenTurn();
    harness.socket.dropAfterFirstEvent();
    await harness.runReconnectTimer(1_000);
    expect(harness.socket.sentFrames()).toContainEqual(
      expect.objectContaining({ type: 'resume', sinceSeq: expect.any(Number) }),
    );
    await harness.emitResumeFixture();
    expect(harness.deliveredSeqs()).toEqual([...new Set(harness.deliveredSeqs())]);

    await harness.chat.answerQuestion(
      { id: harness.conversation.id, origin: 'gateway' },
      harness.turnId,
      'question-01',
      'Use option A',
    );
    await harness.chat.cancel({ id: harness.conversation.id, origin: 'gateway' }, harness.turnId);
    expect(harness.socket.sentFrames()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'answer', id: harness.turnId }),
        expect.objectContaining({ type: 'cancel', id: harness.turnId }),
      ]),
    );
    expect(harness.socket.closedBeforeCancelledTerminal()).toBe(false);
  });

  it('keeps known-capable offline data read-only with no legacy fallback write', async () => {
    const harness = await createConversationSyncHarness({ capability: 'capable', offline: true });
    const list = await harness.chat.listConversations();
    expect(list.gatewayOnline).toBe(false);
    expect(list.items.every((item: { readOnly: boolean }) => item.readOnly)).toBe(true);
    await expect(harness.chat.createConversation('agent-1', 'offline-create')).rejects.toThrow(
      'read-only',
    );
    expect(harness.legacyCreate).not.toHaveBeenCalled();
  });

  it('reconciles a deletion missed while offline after the first canonical refresh', async () => {
    const harness = await createConversationSyncHarness({ capability: 'capable' });
    const ref = { id: harness.conversation.id, origin: 'gateway' } as const;
    await harness.seedSameIdLocalHistory(ref.id);
    await harness.loadRendererConversations();
    await harness.loadRendererMessages(ref);

    await harness.goOffline();
    harness.deleteRemotelyWithoutSse(ref.id);
    const cached = await harness.chat.listConversations();
    expect(cached.items).toContainEqual(expect.objectContaining(ref));

    await harness.reconnectWithoutSse();
    const refreshed = await harness.chat.listConversations();
    await harness.flushRenderer();
    expect(refreshed.items).not.toContainEqual(
      expect.objectContaining({ id: ref.id, origin: 'gateway' }),
    );
    await expect(harness.gatewayCache.getConversation(ref.id)).resolves.toBeNull();
    await expect(harness.gatewayCache.getMessagePage(ref.id)).resolves.toEqual({
      items: [],
      nextCursor: null,
      throughSeq: 0,
    });
    expect(harness.invalidations()).toContainEqual({
      type: 'deleted',
      conversation: ref,
    });
    expect(harness.rendererConversation(ref)).toBeNull();
    expect(harness.rendererMessages(ref)).toEqual([]);
    expect(harness.rendererConversation({ id: ref.id, origin: 'local' })).not.toBeNull();
  });

  it('retains the current local path only for a reachable explicit older gateway', async () => {
    const harness = await createConversationSyncHarness({ capability: 'legacy' });
    const created = await harness.chat.createConversation('agent-1', 'legacy-create');
    expect(created.origin).toBe('local');
    await harness.chat.sendMessage(
      { id: created.id, origin: 'local' },
      'legacy-turn',
      'legacy message',
    );
    expect(harness.legacyCreate).toHaveBeenCalledOnce();
    expect(harness.gatewayCreate).not.toHaveBeenCalled();
  });

  it('returns one canonical conversation for a repeated create request ID', async () => {
    const harness = await createConversationSyncHarness({ capability: 'capable' });

    const first = await harness.chat.createConversation('agent-1', 'idempotent-create');
    const second = await harness.chat.createConversation('agent-1', 'idempotent-create');
    const list = await harness.chat.listConversations();

    expect(second).toEqual(first);
    expect(list.items.filter((item) => item.id === first.id)).toHaveLength(1);
  });

  it('returns the original acceptance and one optimistic user row for a repeated turn ID', async () => {
    const harness = await createConversationSyncHarness({ capability: 'capable' });

    const result = await harness.retrySameTurn();

    expect(result.acceptances).toEqual([
      await harness.fixture('chat-accepted.json'),
      await harness.fixture('chat-accepted.json'),
    ]);
    expect(result.userMessages).toHaveLength(1);
    expect(result.userMessages[0]).toMatchObject({
      id: (await harness.fixture('chat-accepted.json')).userMessageId,
      turnId: harness.turnId,
    });
  });

  it('keeps an active iOS turn authoritative until explicit cancel completes', async () => {
    const harness = await createConversationSyncHarness({ capability: 'capable' });
    const busy = await harness.fixture('errors/conversation-busy.json');

    const result = await harness.rejectDistinctTurnWhileRemoteActive();

    expect(result.error).toMatchObject({
      code: busy.code,
      retryable: busy.retryable,
      activeTurnId: result.remoteTurnId,
    });
    expect(result.beforeCancel.activeTurnId).toBe(result.remoteTurnId);
    await expect(result.renameWhileActive).rejects.toThrow('read-only');
    await expect(result.deleteWhileActive).rejects.toThrow('read-only');

    await harness.completeRemoteCancel(result.remoteTurnId);
    expect(harness.rendererConversation(result.ref)).toMatchObject({ activeTurnId: null });
    await expect(harness.renameRendererConversation(result.ref, 'After cancel')).resolves.toBe(
      undefined,
    );
  });

  it('deduplicates sequence, replays a gap, and refreshes canonical terminal IDs', async () => {
    const harness = await createConversationSyncHarness({ capability: 'capable' });

    const result = await harness.replayGapToTerminal();

    expect(result.deliveredSeqs).toEqual([1, 2, 3, 4, 5]);
    expect(result.messageIds).toEqual([
      '018f0f4a-5c42-7a8b-9c01-3234567890ab',
      '018f0f4a-5c42-7a8b-9c01-4234567890ab',
    ]);
  });

  it('lets a concurrent manual rename beat generated auto-title', async () => {
    const harness = await createConversationSyncHarness({ capability: 'capable' });

    const result = await harness.runTitleLinkageRace();

    expect(result.current.title).toBe('Human title');
    expect(result.current.owningIssueId).toBe('issue-race');
  });

  it('retries only linkage fields when the canonical title changed', async () => {
    const harness = await createConversationSyncHarness({ capability: 'capable' });

    const result = await harness.runTitleLinkageRace();

    expect(result.patchCalls).toHaveLength(2);
    expect(result.patchCalls[1]).toEqual([
      harness.conversation.id,
      3,
      { owningIssueId: 'issue-race', projectId: 'project-race' },
    ]);
  });

  it('purges only the matching gateway renderer state for an SSE tombstone', async () => {
    const harness = await createConversationSyncHarness({ capability: 'capable' });
    const ref = { id: harness.conversation.id, origin: 'gateway' } as const;
    await harness.seedSameIdLocalHistory(ref.id);
    await harness.loadRendererConversations();
    await harness.loadRendererMessages(ref);

    await harness.emitFrozenSseDeletion();

    await expect(harness.gatewayCache.getConversation(ref.id)).resolves.toBeNull();
    await expect(harness.gatewayCache.getMessagePage(ref.id)).resolves.toEqual({
      items: [],
      nextCursor: null,
      throughSeq: 0,
    });
    expect(harness.rendererConversation(ref)).toBeNull();
    expect(harness.rendererMessages(ref)).toEqual([]);
    expect(harness.rendererConversation({ id: ref.id, origin: 'local' })).not.toBeNull();
  });

  it('keeps an archived agent conversation read-only with its agent snapshot', async () => {
    const harness = await createConversationSyncHarness({ capability: 'capable' });

    const archived = await harness.archiveConversationForDeletedAgent();

    expect(archived).toMatchObject({
      status: 'archived',
      readOnly: true,
      agentName: 'Mobile Helper',
    });
  });

  it('never sends a same-ID local legacy ref to the capable gateway repository', async () => {
    const harness = await createConversationSyncHarness({ capability: 'capable' });
    await harness.seedSameIdLocalHistory(harness.conversation.id);

    await harness.readSameIdLocalHistory();

    expect(harness.gatewayCallsForId(harness.conversation.id)).toEqual([]);
  });

  it('deep-fetches a page-51 project link without creating a replacement', async () => {
    const harness = await createConversationSyncHarness({ capability: 'capable' });
    const ref = await harness.addPage51Conversation();
    await harness.loadRendererConversations();

    const found = await useChatStore.getState().ensureConversation(ref);

    expect(found).toMatchObject(ref);
    expect(harness.gatewayGet).toHaveBeenCalledWith(ref.id);
    expect(harness.gatewayCreate).not.toHaveBeenCalled();
  });

  it('round-trips unknown event JSON through transport/cache and renders a neutral row', async () => {
    const harness = await createConversationSyncHarness({ capability: 'capable' });

    const message = await harness.roundTripUnknownEvent();
    render(createElement(MessageBubble, { message }));

    expect(message.content).toEqual(
      expect.objectContaining({
        type: 'assistant',
        events: [expect.objectContaining({ type: 'future_runtime_marker' })],
      }),
    );
    expect(screen.getByText('Activity from a newer Dash version')).toBeTruthy();
  });

  it('retains every frozen structured error field through main-process classification', async () => {
    const names = [
      'errors/unauthorized.json',
      'errors/not-found.json',
      'errors/validation-failed.json',
      'errors/revision-conflict.json',
      'errors/conversation-busy.json',
      'errors/rate-limited.json',
      'errors/gateway-offline.json',
      'errors/capability-required.json',
    ];

    for (const name of names) {
      const apiError = await fixture<MobileApiError>(name);
      const wire = structuredClone(
        await captureChatIpcResult(async () => {
          throw new GatewayHttpError(409, 'fixture', JSON.stringify(apiError), apiError);
        }),
      );
      let classified: unknown;
      try {
        unwrapChatIpcResult(wire);
      } catch (error) {
        classified = error;
      }
      expect(classified).toMatchObject({
        apiError: {
          code: apiError.code,
          retryable: apiError.retryable,
          ...(apiError.details === undefined ? {} : { details: apiError.details }),
        },
      });
    }
  });
});

type Capability = 'capable' | 'legacy';

interface HarnessOptions {
  capability: Capability;
  offline?: boolean;
}

async function fixture<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(resolve(fixturesRoot, name), 'utf8')) as T;
}

async function fixtureLines<T>(name: string): Promise<T[]> {
  return (await readFile(resolve(fixturesRoot, name), 'utf8'))
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

class ProgrammableFixtureClient {
  online = true;
  readonly calls: Array<{ method: string; args: unknown[] }> = [];
  readonly patchCalls: Array<
    [
      id: string,
      revision: number,
      patch: Partial<Pick<ConversationSummary, 'title' | 'owningIssueId' | 'projectId'>>,
    ]
  > = [];
  readonly conversations = new Map<string, ConversationSummary>();
  readonly messages = new Map<string, ConversationMessagePage>();
  readonly requests = new Map<string, ConversationSummary>();
  readonly hiddenFromFirstPage = new Set<string>();
  replayPage: ReplayPage;
  manualTitleOnNextPatch: string | null = null;
  private base: ConversationSummary;

  constructor(page: ConversationPage, messages: ConversationMessagePage, replayPage: ReplayPage) {
    this.base = clone(page.items[0]);
    for (const conversation of page.items)
      this.conversations.set(conversation.id, clone(conversation));
    this.messages.set(this.base.id, clone(messages));
    this.replayPage = clone(replayPage);
  }

  private assertOnline(): void {
    if (!this.online) throw new TypeError('fixture transport offline');
  }

  async listConversations(
    params: {
      agentId?: string;
      limit?: number;
      cursor?: string;
    } = {},
  ): Promise<ConversationPage> {
    this.calls.push({ method: 'listConversations', args: [clone(params)] });
    this.assertOnline();
    const all = [...this.conversations.values()].filter(
      (item) => item.status !== 'deleted' && (!params.agentId || item.agentId === params.agentId),
    );
    const visible = params.cursor
      ? all.filter((item) => this.hiddenFromFirstPage.has(item.id))
      : all.filter((item) => !this.hiddenFromFirstPage.has(item.id));
    const limit = params.limit ?? 50;
    return {
      items: clone(visible.slice(0, limit)),
      nextCursor:
        !params.cursor && all.some((item) => this.hiddenFromFirstPage.has(item.id))
          ? 'fixture-page-2'
          : null,
    };
  }

  async getConversation(id: string): Promise<ConversationSummary> {
    this.calls.push({ method: 'getConversation', args: [id] });
    this.assertOnline();
    const conversation = this.conversations.get(id);
    if (!conversation) {
      const apiError = await fixture<MobileApiError>('errors/not-found.json');
      throw new GatewayHttpError(404, 'getConversation', JSON.stringify(apiError), apiError);
    }
    return clone(conversation);
  }

  async createConversation(
    agentId: string,
    requestId: string,
    metadata: Partial<Pick<ConversationSummary, 'title' | 'owningIssueId' | 'projectId'>> = {},
  ): Promise<ConversationSummary> {
    this.calls.push({ method: 'createConversation', args: [agentId, requestId, clone(metadata)] });
    this.assertOnline();
    const existing = this.requests.get(requestId);
    if (existing) return clone(existing);
    const created =
      requestId === 'create-request-1'
        ? {
            ...this.base,
            revision: 1,
            status: 'idle' as const,
            activeTurnId: null,
            lastSeq: 0,
          }
        : {
            ...clone(this.base),
            id: `created-${requestId}`,
            agentId,
            title: metadata.title ?? 'New Conversation',
            owningIssueId: metadata.owningIssueId ?? null,
            projectId: metadata.projectId ?? null,
            revision: 1,
            lastSeq: 0,
            lastMessagePreview: null,
          };
    this.requests.set(requestId, created);
    this.conversations.set(created.id, created);
    this.messages.set(created.id, { items: [], nextCursor: null, throughSeq: 0 });
    return clone(created);
  }

  async getConversationMessages(
    id: string,
    _params: { limit?: number; before?: string } = {},
  ): Promise<ConversationMessagePage> {
    this.calls.push({ method: 'getConversationMessages', args: [id, clone(_params)] });
    this.assertOnline();
    return clone(this.messages.get(id) ?? { items: [], nextCursor: null, throughSeq: 0 });
  }

  async patchConversation(
    id: string,
    revision: number,
    patch: Partial<Pick<ConversationSummary, 'title' | 'owningIssueId' | 'projectId'>>,
  ): Promise<ConversationSummary> {
    this.calls.push({ method: 'patchConversation', args: [id, revision, clone(patch)] });
    this.patchCalls.push([id, revision, clone(patch)]);
    this.assertOnline();
    const current = await this.getConversation(id);
    if (this.manualTitleOnNextPatch !== null) {
      const manuallyRenamed = {
        ...current,
        title: this.manualTitleOnNextPatch,
        revision: current.revision + 1,
      };
      this.manualTitleOnNextPatch = null;
      this.conversations.set(id, manuallyRenamed);
      const apiError = await fixture<MobileApiError>('errors/revision-conflict.json');
      throw new GatewayHttpError(409, 'patchConversation', JSON.stringify(apiError), {
        ...apiError,
        details: { current: clone(manuallyRenamed) },
      });
    }
    if (current.revision !== revision) {
      const apiError = await fixture<MobileApiError>('errors/revision-conflict.json');
      throw new GatewayHttpError(409, 'patchConversation', JSON.stringify(apiError), {
        ...apiError,
        details: { current },
      });
    }
    const updated = { ...current, ...patch, revision: revision + 1 };
    this.conversations.set(id, updated);
    return clone(updated);
  }

  async deleteConversation(id: string, revision: number): Promise<ConversationSummary> {
    this.calls.push({ method: 'deleteConversation', args: [id, revision] });
    this.assertOnline();
    const current = await this.getConversation(id);
    const deleted: ConversationSummary = {
      ...current,
      revision: revision + 1,
      status: 'deleted',
      activeTurnId: null,
      deletedAt: '2026-07-12T00:01:00.000Z',
    };
    this.conversations.set(id, deleted);
    return clone(deleted);
  }

  async replayConversationEvents(
    _agentId: string,
    _conversationId: string,
    sinceSeq: number,
  ): Promise<ReplayPage> {
    this.calls.push({
      method: 'replayConversationEvents',
      args: [_agentId, _conversationId, sinceSeq],
    });
    this.assertOnline();
    return { entries: clone(this.replayPage.entries.filter((entry) => entry.seq > sinceSeq)) };
  }

  setConversation(conversation: ConversationSummary): void {
    this.conversations.set(conversation.id, clone(conversation));
  }

  deleteWithoutTombstone(id: string): void {
    this.conversations.delete(id);
  }
}

class FakeSocket implements ChatSocket {
  readyState = 0;
  readonly sent: MobileWsClientFrame[] = [];
  private readonly listeners = new Map<string, Array<(event: ChatSocketEvent) => void>>();

  constructor(private readonly owner: SocketHarness) {}

  addEventListener(name: string, listener: (event: ChatSocketEvent) => void): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as MobileWsClientFrame);
  }

  close(): void {
    if (this.sent.some((frame) => frame.type === 'cancel') && !this.owner.cancelledTerminalSeen) {
      this.owner.closedBeforeCancelled = true;
    }
    this.readyState = 3;
  }

  open(): void {
    this.readyState = 1;
    this.emit('open', {});
  }

  frame(frame: MobileWsServerFrame): void {
    if (frame.type === 'done' && frame.outcome === 'cancelled') {
      this.owner.cancelledTerminalSeen = true;
    }
    this.emit('message', { data: JSON.stringify(frame) });
  }

  drop(): void {
    this.readyState = 3;
    this.emit('close', { code: 1006, reason: 'fixture drop' });
  }

  private emit(name: string, event: ChatSocketEvent): void {
    for (const listener of this.listeners.get(name) ?? []) listener(event);
  }
}

class SocketHarness {
  readonly sockets: FakeSocket[] = [];
  stream: MobileWsServerFrame[] = [];
  cancelledTerminalSeen = false;
  closedBeforeCancelled = false;

  factory = (): FakeSocket => {
    const socket = new FakeSocket(this);
    this.sockets.push(socket);
    return socket;
  };

  current(): FakeSocket {
    const socket = this.sockets.at(-1);
    if (!socket) throw new Error('Fixture socket was not created');
    return socket;
  }

  dropAfterFirstEvent(): void {
    this.current().frame(this.stream[1]);
    this.current().drop();
  }

  sentFrames(): MobileWsClientFrame[] {
    return this.sockets.flatMap((socket) => socket.sent);
  }

  closedBeforeCancelledTerminal(): boolean {
    return this.closedBeforeCancelled;
  }
}

function resetRenderer(): void {
  useChatStore.setState({
    conversations: [],
    nextConversationCursor: null,
    conversationAuthority: 'unresolved',
    gatewayOnline: false,
    selectedConversationRef: null,
    openTabKeys: [],
    messages: {},
    messageCursor: {},
    throughSeq: {},
    streamingFrames: {},
    lastSeq: {},
    localTurnIds: {},
    sending: {},
    unreadConversations: new Set(),
    conversationError: null,
    connectionIssue: null,
  });
}

async function snapshotDirectory(path: string): Promise<Record<string, string>> {
  const names = await readdir(path, { recursive: true }).catch(() => [] as string[]);
  const result: Record<string, string> = {};
  for (const name of names.map(String).sort()) {
    const file = resolve(path, name);
    const content = await readFile(file, 'utf8').catch(() => null);
    if (content !== null) result[name] = content;
  }
  return result;
}

async function createConversationSyncHarness(options: HarnessOptions) {
  const dataDir = await mkdtemp(join(tmpdir(), 'mc-conversation-sync-'));
  const store = new ConversationStore(dataDir);
  const seededLocal = await store.create('local-agent');
  await store.rename(seededLocal.id, 'On this Mac history');
  const legacy = new LegacyConversationRepository(store, (agentId) => `Local ${agentId}`);
  const page = await fixture<ConversationPage>('conversations-page.json');
  const messagePage = await fixture<ConversationMessagePage>('conversation-messages-page.json');
  const replayPage = await fixture<ReplayPage>('replay.json');
  const stream = await fixtureLines<MobileWsServerFrame>('chat-stream.jsonl');
  const resume = await fixtureLines<MobileWsServerFrame | MobileWsClientFrame>('chat-resume.jsonl');
  const client = new ProgrammableFixtureClient(page, messagePage, replayPage);
  const gatewayCache = new GatewayConversationCache(dataDir, 'gateway-01');
  const invalidationLog: Array<{ type: 'deleted'; conversation: ConversationRef }> = [];
  const repository = new GatewayConversationRepository(
    'gateway-01',
    client,
    gatewayCache,
    (conversation) => invalidationLog.push({ type: 'deleted', conversation }),
  );
  await repository.list({ limit: 50 });
  const controller = new ConversationController(legacy);
  const configure = (online: boolean): void => {
    controller.configure({
      gatewayId: 'gateway-01',
      online,
      capabilities:
        options.capability === 'capable' ? ['conversation-sync-v1', 'chat-resume-v1'] : [],
      repository,
    });
  };
  configure(!options.offline);
  if (options.offline) {
    client.online = false;
    await repository.list({ limit: 50 });
  }

  const socket = new SocketHarness();
  socket.stream = stream;
  const delivered: MobileWsServerFrame[] = [];
  const rendererJobs: Promise<void>[] = [];
  const transport = new ResumableChatTransport({
    connection: { url: 'wss://fixture.invalid/ws/chat' },
    channelId: 'mobile-ios',
    socketFactory: socket.factory,
    replay: (ref, agentId, sinceSeq) => controller.replay(ref, agentId, sinceSeq),
    onFrame: (frame) => {
      delivered.push(frame);
      const conversationId = 'conversationId' in frame ? frame.conversationId : undefined;
      const current = conversationId ? client.conversations.get(conversationId) : undefined;
      if (conversationId && current && 'seq' in frame) {
        client.setConversation({
          ...current,
          revision: frame.type === 'accepted' ? frame.revision : current.revision,
          status:
            frame.type === 'done' ? 'idle' : frame.type === 'error' ? 'interrupted' : 'running',
          activeTurnId: frame.type === 'done' || frame.type === 'error' ? null : frame.id,
          lastSeq: frame.seq,
        });
      }
      rendererJobs.push(useChatStore.getState().applyFrame(frame));
    },
    onConnectionError: vi.fn(),
    onProtocolError: vi.fn(),
  });
  const service = new ChatService(
    store,
    vi.fn(),
    vi.fn(),
    vi.fn(),
    { channelPort: 9 },
    undefined,
    controller,
    transport,
  );
  const handlers = createCanonicalChatHandlers(service, controller);
  const legacyCreate = vi.spyOn(legacy, 'create');
  const gatewayCreate = vi.spyOn(client, 'createConversation');
  const gatewayGet = vi.spyOn(client, 'getConversation');

  mockApi.chatListConversations.mockImplementation((cursor?: string) =>
    handlers.listConversations(cursor),
  );
  mockApi.chatGetConversation.mockImplementation((ref: ConversationRef) =>
    handlers.getConversation(ref),
  );
  mockApi.chatGetMessages.mockImplementation((ref: ConversationRef, before?: string) =>
    handlers.getMessages(ref, before),
  );
  mockApi.chatCreateConversation.mockImplementation((agentId: string, requestId: string) =>
    handlers.createConversation(agentId, requestId),
  );
  mockApi.chatSend.mockImplementation(
    (ref: ConversationRef, turnId: string, text: string, images) =>
      handlers.sendMessage(ref, turnId, text, images),
  );
  mockApi.chatRenameConversation.mockImplementation(
    (ref: ConversationRef, revision: number, title: string) =>
      handlers.renameConversation(ref, revision, title),
  );
  mockApi.chatDeleteConversation.mockImplementation((ref: ConversationRef, revision: number) =>
    handlers.deleteConversation(ref, revision),
  );
  mockApi.chatCancel.mockImplementation((ref: ConversationRef, turnId: string) => {
    void handlers.cancel(ref, turnId);
  });
  mockApi.chatAnswerQuestion.mockImplementation(
    (ref: ConversationRef, turnId: string, questionId: string, answer: string) => {
      void handlers.answerQuestion(ref, turnId, questionId, answer);
    },
  );
  resetRenderer();

  let processedInvalidations = 0;
  const flushRenderer = async (): Promise<void> => {
    await Promise.all(rendererJobs.splice(0));
    const seen = new Set<string>();
    while (processedInvalidations < invalidationLog.length) {
      const event = invalidationLog[processedInvalidations++];
      const key = `${event.type}:${event.conversation.origin}:${event.conversation.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      await useChatStore.getState().invalidateConversation(event);
    }
  };

  const sendAndAccept = async (ref: ConversationRef, turnId: string, text: string) => {
    const current = client.conversations.get(ref.id);
    if (current && current.lastSeq !== 0) {
      client.setConversation({
        ...current,
        revision: 1,
        status: 'idle',
        activeTurnId: null,
        lastSeq: 0,
      });
    }
    const pending = handlers.sendMessage(ref, turnId, text);
    await vi.waitFor(() => expect(socket.sockets).toHaveLength(1));
    const activeSocket = socket.current();
    activeSocket.open();
    const accepted =
      await fixture<Extract<MobileWsServerFrame, { type: 'accepted' }>>('chat-accepted.json');
    const matchingAccepted = { ...accepted, id: turnId };
    activeSocket.frame(matchingAccepted);
    const result = await pending;
    await vi.waitFor(() => expect(delivered).toContainEqual(matchingAccepted));
    return result;
  };

  const baseRef = { id: page.items[0].id, origin: 'gateway' as const };
  const accepted =
    await fixture<Extract<MobileWsServerFrame, { type: 'accepted' }>>('chat-accepted.json');

  const retrySameTurn = async () => {
    client.setConversation({
      ...page.items[0],
      revision: 1,
      status: 'idle',
      activeTurnId: null,
      lastSeq: 0,
    });
    await useChatStore.getState().loadConversations();
    const key = `${baseRef.origin}:${baseRef.id}`;
    const now = '2026-07-12T00:00:00.000Z';
    useChatStore.setState({
      messages: {
        [key]: [
          {
            id: `optimistic:${accepted.id}`,
            conversationId: accepted.conversationId,
            turnId: accepted.id,
            ordinal: Number.MAX_SAFE_INTEGER,
            role: 'user',
            status: 'accepted',
            content: { type: 'user', text: 'ship the sync' },
            createdAt: now,
            updatedAt: now,
          },
        ],
      },
      lastSeq: { [key]: 0 },
    });

    const first = handlers.sendMessage(baseRef, accepted.id, 'ship the sync');
    await vi.waitFor(() => expect(socket.sockets).toHaveLength(1));
    socket.current().open();
    const second = handlers.sendMessage(baseRef, accepted.id, 'ship the sync');
    await vi.waitFor(() =>
      expect(socket.current().sent.filter((frame) => frame.type === 'message')).toHaveLength(2),
    );
    socket.current().frame(accepted);
    const acceptances = await Promise.all([first, second]);
    await flushRenderer();
    return {
      acceptances,
      userMessages: (useChatStore.getState().messages[key] ?? []).filter(
        (message) => message.role === 'user',
      ),
    };
  };

  const rejectDistinctTurnWhileRemoteActive = async () => {
    const remoteAccepted = resume.find(
      (frame): frame is Extract<MobileWsServerFrame, { type: 'accepted' }> =>
        frame.type === 'accepted',
    );
    const cancelled = resume.find(
      (frame): frame is Extract<MobileWsServerFrame, { type: 'done' }> =>
        frame.type === 'done' && frame.outcome === 'cancelled',
    );
    if (!remoteAccepted || !cancelled) throw new Error('Frozen remote turn is missing');
    const remoteTurnId = remoteAccepted.id;
    client.setConversation({
      ...page.items[0],
      revision: remoteAccepted.revision,
      status: 'running',
      activeTurnId: remoteTurnId,
      lastSeq: remoteAccepted.seq,
    });
    client.messages.set(baseRef.id, {
      items: clone(messagePage.items),
      nextCursor: null,
      throughSeq: remoteAccepted.seq,
    });
    await useChatStore.getState().loadConversations();

    const pending = handlers.sendMessage(baseRef, 'distinct-renderer-turn', 'new turn');
    await vi.waitFor(() => expect(socket.sockets).toHaveLength(1));
    socket.current().open();
    const busy = await fixture<MobileApiError>('errors/conversation-busy.json');
    socket.current().frame({
      type: 'error',
      id: 'distinct-renderer-turn',
      error: busy.error,
      code: busy.code,
      retryable: busy.retryable,
      activeTurnId: remoteTurnId,
    });
    let error: unknown;
    try {
      await pending;
    } catch (cause) {
      error = cause;
    }
    const beforeCancel = useChatStore
      .getState()
      .conversations.find(
        (conversation) => conversation.id === baseRef.id && conversation.origin === baseRef.origin,
      );
    if (!beforeCancel) throw new Error('Renderer conversation is missing');
    const renameWhileActive = useChatStore.getState().renameConversation(baseRef, 'Blocked');
    const deleteWhileActive = useChatStore.getState().deleteConversation(baseRef);
    void renameWhileActive.catch(() => undefined);
    void deleteWhileActive.catch(() => undefined);
    return {
      error,
      remoteTurnId,
      cancelled,
      beforeCancel,
      renameWhileActive,
      deleteWhileActive,
      ref: baseRef,
    };
  };

  const completeRemoteCancel = async (remoteTurnId: string) => {
    const cancelled = resume.find(
      (frame): frame is Extract<MobileWsServerFrame, { type: 'done' }> =>
        frame.type === 'done' && frame.id === remoteTurnId && frame.outcome === 'cancelled',
    );
    if (!cancelled) throw new Error('Frozen cancelled terminal is missing');
    const previousSocketCount = socket.sockets.length;
    await handlers.getMessages(baseRef);
    await vi.waitFor(() => expect(socket.sockets).toHaveLength(previousSocketCount + 1));
    socket.current().open();
    await handlers.cancel(baseRef, remoteTurnId);
    expect(socket.current().sent).toContainEqual({ type: 'cancel', id: remoteTurnId });
    socket.current().frame(cancelled);
    await vi.waitFor(() => expect(client.conversations.get(baseRef.id)?.activeTurnId).toBeNull());
    await flushRenderer();
  };

  const replayGapToTerminal = async () => {
    const conversation = {
      ...page.items[0],
      revision: 1,
      status: 'running' as const,
      activeTurnId: accepted.id,
      lastSeq: 0,
    };
    client.setConversation(conversation);
    client.messages.set(baseRef.id, clone(messagePage));
    await useChatStore.getState().loadConversations();
    await transport.subscribe(conversation, accepted.id, 0);
    socket.current().open();
    socket.current().frame(stream[0]);
    socket.current().frame(stream[0]);
    socket.current().frame(stream[2]);
    await vi.waitFor(() =>
      expect(delivered.some((frame) => 'seq' in frame && frame.seq === 5)).toBe(true),
    );
    await flushRenderer();
    return {
      deliveredSeqs: delivered.flatMap((frame) => ('seq' in frame ? [frame.seq] : [])),
      messageIds: (useChatStore.getState().messages[`${baseRef.origin}:${baseRef.id}`] ?? []).map(
        (message) => message.id,
      ),
    };
  };

  const runTitleLinkageRace = async () => {
    client.setConversation({
      ...page.items[0],
      title: 'New Conversation',
      owningIssueId: null,
      projectId: null,
      revision: 1,
      status: 'idle',
      activeTurnId: null,
      lastSeq: 0,
    });
    client.patchCalls.splice(0);
    client.manualTitleOnNextPatch = 'Human title';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.endsWith('/conversation-title')) {
          return new Response(
            JSON.stringify({ title: 'Generated title', project: { id: 'project-race' } }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (url.endsWith('/issues')) {
          return new Response(JSON.stringify({ id: 'issue-race', key: 'TASK-10' }), {
            status: 201,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    service.setGatewayConnection({
      managementBaseUrl: 'https://fixture.invalid',
      managementToken: 'fixture-token',
    });
    await sendAndAccept(baseRef, accepted.id, 'file the mobile sync');
    await vi.waitFor(() => expect(client.patchCalls).toHaveLength(2));
    await vi.waitFor(async () => {
      await expect(gatewayCache.getConversation(baseRef.id)).resolves.toMatchObject({
        title: 'Human title',
        owningIssueId: 'issue-race',
        projectId: 'project-race',
      });
    });
    const current = client.conversations.get(baseRef.id);
    if (!current) throw new Error('Canonical conversation is missing after linkage retry');
    return { current: clone(current), patchCalls: clone(client.patchCalls) };
  };

  const emitFrozenSseDeletion = async () => {
    const body = await readFile(resolve(fixturesRoot, 'sse-conversation-deleted.txt'), 'utf8');
    client.deleteWithoutTombstone(baseRef.id);
    for (const event of parseConversationInvalidations(body)) {
      await repository.invalidate(event.conversation.id, event.type === 'deleted');
      if (event.type === 'deleted') invalidationLog.push(event);
    }
    await flushRenderer();
  };

  const archiveConversationForDeletedAgent = async () => {
    const current = client.conversations.get(baseRef.id);
    if (!current) throw new Error('Frozen conversation is missing');
    client.setConversation({
      ...current,
      status: 'archived',
      activeTurnId: null,
      revision: current.revision + 1,
    });
    await useChatStore.getState().loadConversations();
    const archived = useChatStore
      .getState()
      .conversations.find(
        (conversation) => conversation.id === baseRef.id && conversation.origin === baseRef.origin,
      );
    if (!archived) throw new Error('Archived renderer conversation is missing');
    return archived;
  };

  const readSameIdLocalHistory = async () => {
    client.calls.splice(0);
    const ref = { id: baseRef.id, origin: 'local' as const };
    await expect(handlers.getConversation(ref)).resolves.toMatchObject(ref);
    await expect(handlers.getMessages(ref)).resolves.toMatchObject({ items: [] });
    await expect(handlers.renameConversation(ref, 0, 'Blocked')).rejects.toThrow('read-only');
  };

  const addPage51Conversation = async (): Promise<ConversationRef> => {
    const deep = {
      ...page.items[0],
      id: '018f0f4a-5c42-7a8b-9c01-page0000051',
      title: 'Deep linked conversation',
    };
    client.setConversation(deep);
    client.messages.set(deep.id, { items: [], nextCursor: null, throughSeq: 0 });
    client.hiddenFromFirstPage.add(deep.id);
    return { id: deep.id, origin: 'gateway' };
  };

  const roundTripUnknownEvent = async (): Promise<ConversationMessage> => {
    const unknown = resume.find(
      (frame): frame is Extract<MobileWsServerFrame, { type: 'event' }> =>
        frame.type === 'event' && frame.event.type === 'future_runtime_marker',
    );
    if (!unknown || unknown.seq === undefined) throw new Error('Frozen unknown event is missing');
    const conversation = {
      ...page.items[0],
      revision: 3,
      status: 'running' as const,
      activeTurnId: unknown.id,
      lastSeq: unknown.seq - 1,
    };
    const message: ConversationMessage = {
      id: '018f0f4a-5c42-7a8b-9c01-9234567890ab',
      conversationId: baseRef.id,
      turnId: unknown.id,
      ordinal: 2,
      role: 'assistant',
      status: 'completed',
      content: { type: 'assistant', events: [clone(unknown.event)] },
      createdAt: '2026-07-12T00:00:07.000Z',
      updatedAt: '2026-07-12T00:00:08.000Z',
    };
    client.setConversation(conversation);
    client.messages.set(baseRef.id, {
      items: [message],
      nextCursor: null,
      throughSeq: unknown.seq,
    });
    await useChatStore.getState().loadConversations();
    await transport.subscribe(conversation, unknown.id, unknown.seq - 1);
    socket.current().open();
    socket.current().frame(unknown);
    await vi.waitFor(() => expect(delivered).toContainEqual(unknown));
    await useChatStore.getState().ensureMessages(baseRef);
    await flushRenderer();
    const cached = await gatewayCache.getMessagePage(baseRef.id);
    expect(cached.items[0]?.content).toEqual(message.content);
    const rendererMessage =
      useChatStore.getState().messages[`${baseRef.origin}:${baseRef.id}`]?.[0];
    if (!rendererMessage) throw new Error('Unknown-event renderer message is missing');
    return rendererMessage;
  };

  cleanups.push(async () => {
    transport.closeAll();
    await service.drainBackgroundTasks();
    await flushRenderer();
    await rm(dataDir, { recursive: true, force: true });
    resetRenderer();
  });

  return {
    chat: handlers,
    client,
    controller,
    service,
    transport,
    gatewayCache,
    legacyCreate,
    gatewayCreate,
    gatewayGet,
    conversation: page.items[0],
    turnId: (
      await fixture<Extract<MobileWsServerFrame, { type: 'accepted' }>>('chat-accepted.json')
    ).id,
    socket,
    fixture,
    sendAndAccept,
    retrySameTurn,
    rejectDistinctTurnWhileRemoteActive,
    completeRemoteCancel,
    replayGapToTerminal,
    runTitleLinkageRace,
    emitFrozenSseDeletion,
    archiveConversationForDeletedAgent,
    readSameIdLocalHistory,
    addPage51Conversation,
    roundTripUnknownEvent,
    async startFrozenTurn() {
      vi.useFakeTimers();
      await sendAndAccept(
        { id: page.items[0].id, origin: 'gateway' },
        stream[0].id,
        'ship the sync',
      );
    },
    async runReconnectTimer(milliseconds: number) {
      await vi.advanceTimersByTimeAsync(milliseconds);
      socket.current().open();
    },
    async emitResumeFixture() {
      const question = resume.find(
        (frame): frame is MobileWsServerFrame =>
          frame.type === 'event' && frame.id === stream[0].id,
      );
      if (!question) throw new Error('Frozen resume question is missing');
      socket.current().frame(question);
      await vi.waitFor(() => expect(delivered).toContainEqual(question));
    },
    deliveredSeqs() {
      return delivered.flatMap((frame) => ('seq' in frame ? [frame.seq] : []));
    },
    async readLegacyDirectory() {
      return snapshotDirectory(resolve(dataDir, 'conversations'));
    },
    async loadRendererConversations() {
      await useChatStore.getState().loadConversations();
    },
    async loadRendererMessages(ref: ConversationRef) {
      await useChatStore.getState().ensureMessages(ref);
    },
    async seedSameIdLocalHistory(id: string) {
      const existing = await store.listAll();
      await mkdir(resolve(dataDir, 'conversations'), { recursive: true });
      await writeFile(
        resolve(dataDir, 'conversations/index.json'),
        JSON.stringify([
          ...existing.filter((item) => item.id !== id),
          {
            id,
            agentId: 'local-agent',
            title: 'Same ID local history',
            createdAt: '2026-07-01T00:00:00.000Z',
            updatedAt: '2026-07-01T00:00:00.000Z',
          },
        ]),
      );
    },
    async goOffline() {
      client.online = false;
      configure(false);
    },
    deleteRemotelyWithoutSse(id: string) {
      client.deleteWithoutTombstone(id);
    },
    async reconnectWithoutSse() {
      client.online = true;
      configure(true);
    },
    invalidations() {
      return [...invalidationLog];
    },
    gatewayCallsForId(id: string) {
      return client.calls.filter((call) => call.args.some((argument) => argument === id));
    },
    async renameRendererConversation(ref: ConversationRef, title: string) {
      await useChatStore.getState().renameConversation(ref, title);
    },
    rendererConversation(ref: ConversationRef): McConversationView | null {
      return (
        useChatStore
          .getState()
          .conversations.find(
            (conversation) => conversation.id === ref.id && conversation.origin === ref.origin,
          ) ?? null
      );
    },
    rendererMessages(ref: ConversationRef) {
      return useChatStore.getState().messages[`${ref.origin}:${ref.id}`] ?? [];
    },
    flushRenderer,
  };
}
