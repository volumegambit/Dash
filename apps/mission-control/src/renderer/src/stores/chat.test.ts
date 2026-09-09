import type { ConversationRef, McConversationView } from '@dash/mc';
import type {
  ConversationMessage,
  MobileWsServerFrame,
  SubagentListEntry,
} from '@dash/mobile-contract';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockApi } from '../../../../vitest.setup.js';
import { conversationKey, initChatListeners, useChatStore } from './chat.js';

const gatewayConversation: McConversationView = {
  id: 'shared-id',
  agentId: 'agent-1',
  agentName: 'Gateway Agent',
  title: 'Gateway conversation',
  revision: 2,
  status: 'idle',
  activeTurnId: null,
  owningIssueId: null,
  projectId: null,
  lastSeq: 0,
  lastMessagePreview: 'hello',
  createdAt: '2026-07-12T00:00:00Z',
  updatedAt: '2026-07-12T00:00:02Z',
  kind: 'user',
  origin: 'gateway',
  offline: false,
  readOnly: false,
};

const localConversation: McConversationView = {
  ...gatewayConversation,
  agentName: 'Local Agent',
  title: 'On this Mac',
  origin: 'local',
  updatedAt: '2026-07-12T00:00:01Z',
};

function message(
  id: string,
  ref: ConversationRef,
  role: 'user' | 'assistant' = 'user',
): ConversationMessage {
  return {
    id,
    conversationId: ref.id,
    turnId: 'turn-1',
    ordinal: role === 'user' ? 1 : 2,
    role,
    status: 'completed',
    content:
      role === 'user'
        ? { type: 'user', text: `${ref.origin} message` }
        : { type: 'assistant', events: [{ type: 'text_delta', text: 'Canonical reply' }] },
    createdAt: '2026-07-12T00:00:01Z',
    updatedAt: '2026-07-12T00:00:01Z',
  };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.restoreAllMocks();
  mockApi.chatListConversations.mockReset();
  mockApi.chatGetConversation.mockReset();
  mockApi.chatGetMessages.mockReset();
  mockApi.chatCreateConversation.mockReset();
  mockApi.chatSend.mockReset();
  mockApi.chatRenameConversation.mockReset();
  mockApi.chatDeleteConversation.mockReset();
  mockApi.subagentsList.mockReset();
  mockApi.subagentsList.mockResolvedValue([]);
  mockApi.subagentStop.mockReset();
  mockApi.subagentStop.mockResolvedValue({ ok: true, status: 'cancelled' });
  mockApi.subagentResume.mockReset();
  mockApi.subagentResume.mockResolvedValue({ ok: true, status: 'running', mode: 'queued' });
  mockApi.conversationMessages.mockReset();
  mockApi.conversationMessages.mockResolvedValue({ items: [], nextCursor: null, throughSeq: 0 });
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
    subagents: [],
    subagentUi: {},
  });
});

describe('canonical chat store', () => {
  it('stores the first-page cursor and verified authority', async () => {
    mockApi.chatListConversations.mockResolvedValue({
      items: [localConversation, gatewayConversation],
      nextCursor: 'page-2',
      authority: 'gateway',
      gatewayOnline: true,
    });

    await useChatStore.getState().loadConversations();

    expect(useChatStore.getState()).toMatchObject({
      conversations: [gatewayConversation, localConversation],
      nextConversationCursor: 'page-2',
      conversationAuthority: 'gateway',
      gatewayOnline: true,
    });
  });

  it('drops an older overlapping list response while reconciling the authoritative first page', async () => {
    const stale = deferred<{
      items: McConversationView[];
      nextCursor: string | null;
      authority: 'gateway';
      gatewayOnline: boolean;
    }>();
    const fresh = deferred<{
      items: McConversationView[];
      nextCursor: string | null;
      authority: 'gateway';
      gatewayOnline: boolean;
    }>();
    const latest = { ...gatewayConversation, revision: 6, title: 'Event revision' };
    const removed = { ...gatewayConversation, id: 'removed-from-first-page' };
    useChatStore.setState({ conversations: [latest, removed] });
    mockApi.chatListConversations
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(fresh.promise);

    const staleLoad = useChatStore.getState().loadConversations();
    const freshLoad = useChatStore.getState().loadConversations();
    fresh.resolve({
      items: [{ ...gatewayConversation, revision: 5, title: 'Fresh page title' }],
      nextCursor: null,
      authority: 'gateway',
      gatewayOnline: true,
    });
    await freshLoad;
    stale.resolve({
      items: [{ ...gatewayConversation, revision: 3, title: 'Delayed stale title' }, removed],
      nextCursor: 'stale-page',
      authority: 'gateway',
      gatewayOnline: false,
    });
    await staleLoad;

    expect(useChatStore.getState()).toMatchObject({
      conversations: [{ id: gatewayConversation.id, revision: 6, title: 'Event revision' }],
      nextConversationCursor: null,
      gatewayOnline: true,
    });
  });

  it('rejects pagination started while an authoritative first-page refresh is pending', async () => {
    const firstPage = deferred<{
      items: McConversationView[];
      nextCursor: string | null;
      authority: 'gateway';
      gatewayOnline: boolean;
    }>();
    const stalePage = deferred<{
      items: McConversationView[];
      nextCursor: string | null;
      authority: 'gateway';
      gatewayOnline: boolean;
    }>();
    const removed = { ...gatewayConversation, id: 'deleted-during-refresh' };
    useChatStore.setState({
      conversations: [gatewayConversation, removed],
      nextConversationCursor: 'page-2',
      conversationAuthority: 'gateway',
      gatewayOnline: false,
    });
    mockApi.chatListConversations
      .mockReturnValueOnce(firstPage.promise)
      .mockReturnValueOnce(stalePage.promise);

    const refresh = useChatStore.getState().loadConversations();
    const pagination = useChatStore.getState().loadMoreConversations();
    firstPage.resolve({
      items: [{ ...gatewayConversation, title: 'Authoritative title' }],
      nextCursor: 'page-2',
      authority: 'gateway',
      gatewayOnline: true,
    });
    await refresh;
    stalePage.resolve({
      items: [removed],
      nextCursor: 'stale-cursor',
      authority: 'gateway',
      gatewayOnline: false,
    });
    await pagination;

    expect(mockApi.chatListConversations).toHaveBeenCalledTimes(1);
    expect(useChatStore.getState()).toMatchObject({
      conversations: [{ id: gatewayConversation.id, title: 'Authoritative title' }],
      nextConversationCursor: 'page-2',
      conversationAuthority: 'gateway',
      gatewayOnline: true,
    });

    const pageTwo = { ...gatewayConversation, id: 'page-51' };
    mockApi.chatListConversations.mockReset().mockResolvedValue({
      items: [pageTwo],
      nextCursor: null,
      authority: 'gateway',
      gatewayOnline: true,
    });
    await useChatStore.getState().loadMoreConversations();
    expect(mockApi.chatListConversations).toHaveBeenCalledWith('page-2');
    expect(useChatStore.getState().conversations.map((conversation) => conversation.id)).toEqual([
      gatewayConversation.id,
      pageTwo.id,
    ]);
  });

  it('drops pagination when an authoritative first-page refresh starts after it', async () => {
    const stalePage = deferred<{
      items: McConversationView[];
      nextCursor: string | null;
      authority: 'gateway';
      gatewayOnline: boolean;
    }>();
    const firstPage = deferred<{
      items: McConversationView[];
      nextCursor: string | null;
      authority: 'gateway';
      gatewayOnline: boolean;
    }>();
    const removed = { ...gatewayConversation, id: 'deleted-during-refresh' };
    useChatStore.setState({
      conversations: [gatewayConversation, removed],
      nextConversationCursor: 'page-2',
      conversationAuthority: 'gateway',
      gatewayOnline: false,
    });
    mockApi.chatListConversations
      .mockReturnValueOnce(stalePage.promise)
      .mockReturnValueOnce(firstPage.promise);

    const pagination = useChatStore.getState().loadMoreConversations();
    const refresh = useChatStore.getState().loadConversations();
    firstPage.resolve({
      items: [{ ...gatewayConversation, title: 'Authoritative title' }],
      nextCursor: null,
      authority: 'gateway',
      gatewayOnline: true,
    });
    await refresh;
    stalePage.resolve({
      items: [removed],
      nextCursor: 'stale-cursor',
      authority: 'gateway',
      gatewayOnline: false,
    });
    await pagination;

    expect(useChatStore.getState()).toMatchObject({
      conversations: [{ id: gatewayConversation.id, title: 'Authoritative title' }],
      nextConversationCursor: null,
      conversationAuthority: 'gateway',
      gatewayOnline: true,
    });
  });

  it('loads more without duplicating On-this-Mac history', async () => {
    useChatStore.setState({
      conversations: [gatewayConversation, localConversation],
      nextConversationCursor: 'page-2',
      conversationAuthority: 'gateway',
      gatewayOnline: true,
    });
    const pageTwo = { ...gatewayConversation, id: 'page-51', updatedAt: '2026-07-11T00:00:00Z' };
    mockApi.chatListConversations.mockResolvedValue({
      items: [pageTwo, localConversation],
      nextCursor: null,
      authority: 'gateway',
      gatewayOnline: true,
    });

    await useChatStore.getState().loadMoreConversations();

    expect(mockApi.chatListConversations).toHaveBeenCalledWith('page-2');
    expect(useChatStore.getState().conversations.map(conversationKey)).toEqual([
      'gateway:shared-id',
      'local:shared-id',
      'gateway:page-51',
    ]);
  });

  it('deep-fetches an exact ref outside the first page and upserts it', async () => {
    const ref = { id: 'page-51', origin: 'gateway' as const };
    const deep = { ...gatewayConversation, id: ref.id };
    mockApi.chatGetConversation.mockResolvedValue(deep);

    await expect(useChatStore.getState().ensureConversation(ref)).resolves.toEqual(deep);

    expect(mockApi.chatGetConversation).toHaveBeenCalledWith(ref);
    expect(useChatStore.getState().conversations).toContainEqual(deep);
  });

  it('treats an exact not-found deep fetch as a missing conversation', async () => {
    const ref = { id: 'deleted-conversation', origin: 'gateway' as const };
    mockApi.chatGetConversation.mockRejectedValue({ code: 'not_found' });

    await expect(useChatStore.getState().ensureConversation(ref)).resolves.toBeNull();

    expect(useChatStore.getState().conversationError).toBe('Conversation not found');
  });

  it('keeps same-ID gateway and local tabs, messages, cursors, and selections distinct', async () => {
    const gatewayRef = { id: 'shared-id', origin: 'gateway' as const };
    const localRef = { id: 'shared-id', origin: 'local' as const };
    mockApi.chatGetMessages
      .mockResolvedValueOnce({
        items: [message('gateway-message', gatewayRef)],
        nextCursor: 'gateway-before',
        throughSeq: 5,
      })
      .mockResolvedValueOnce({
        items: [message('local-message', localRef)],
        nextCursor: null,
        throughSeq: 0,
      });
    useChatStore.setState({
      conversations: [gatewayConversation, localConversation],
      gatewayOnline: true,
      conversationAuthority: 'gateway',
    });

    await useChatStore.getState().selectConversation(gatewayRef);
    await useChatStore.getState().selectConversation(localRef);

    expect(useChatStore.getState().openTabKeys).toEqual(['gateway:shared-id', 'local:shared-id']);
    expect(useChatStore.getState().selectedConversationRef).toEqual(localRef);
    expect(useChatStore.getState().messages['gateway:shared-id'][0].id).toBe('gateway-message');
    expect(useChatStore.getState().messages['local:shared-id'][0].id).toBe('local-message');
    expect(useChatStore.getState().messageCursor['gateway:shared-id']).toBe('gateway-before');
  });

  it('replaces the optimistic ID after durable acceptance', async () => {
    const ref = { id: gatewayConversation.id, origin: 'gateway' as const };
    useChatStore.setState({
      conversations: [gatewayConversation],
      gatewayOnline: true,
      conversationAuthority: 'gateway',
    });
    mockApi.chatSend.mockImplementation(async (_ref, turnId) => ({
      type: 'accepted',
      id: turnId,
      conversationId: ref.id,
      userMessageId: 'canonical-user',
      assistantMessageId: 'canonical-assistant',
      revision: 3,
      seq: 1,
    }));

    await useChatStore.getState().sendMessage(ref, 'hello');

    expect(useChatStore.getState().messages['gateway:shared-id'][0].id).toBe('canonical-user');
    expect(mockApi.chatSend.mock.calls[0][0]).toEqual(ref);
    expect(mockApi.chatSend.mock.calls[0][1]).toBe(
      useChatStore.getState().localTurnIds['gateway:shared-id'],
    );
  });

  it('removes only the rejected optimistic message when a send is not accepted', async () => {
    const ref = { id: gatewayConversation.id, origin: 'gateway' as const };
    const existing = message('existing-message', ref);
    useChatStore.setState({
      conversations: [gatewayConversation],
      messages: { 'gateway:shared-id': [existing] },
      gatewayOnline: true,
      conversationAuthority: 'gateway',
    });
    mockApi.chatSend.mockRejectedValue({
      code: 'conversation_busy',
      error: 'Conversation already has an active turn',
      retryable: true,
    });

    await expect(useChatStore.getState().sendMessage(ref, 'rejected')).rejects.toBeDefined();

    expect(useChatStore.getState().messages['gateway:shared-id']).toEqual([existing]);
    expect(useChatStore.getState().localTurnIds['gateway:shared-id']).toBeUndefined();
    expect(useChatStore.getState().sending['gateway:shared-id']).toBe(false);
  });

  it('ignores a duplicate frame sequence', async () => {
    const frame: MobileWsServerFrame = {
      type: 'event',
      id: 'turn-1',
      conversationId: gatewayConversation.id,
      seq: 2,
      event: { type: 'text_delta', text: 'once' },
    };
    useChatStore.setState({
      conversations: [{ ...gatewayConversation, lastSeq: 1 }],
      lastSeq: { 'gateway:shared-id': 1 },
      streamingFrames: {},
    });

    await useChatStore.getState().applyFrame(frame);
    await useChatStore.getState().applyFrame(frame);

    expect(useChatStore.getState().streamingFrames['gateway:shared-id']).toEqual([frame]);
    expect(useChatStore.getState().lastSeq['gateway:shared-id']).toBe(2);
  });

  it('uses the canonical assistant ID on terminal refresh', async () => {
    const ref = { id: gatewayConversation.id, origin: 'gateway' as const };
    const assistant = message('canonical-assistant', ref, 'assistant');
    useChatStore.setState({
      conversations: [{ ...gatewayConversation, status: 'running', activeTurnId: 'turn-1' }],
      lastSeq: { 'gateway:shared-id': 1 },
      localTurnIds: { 'gateway:shared-id': 'turn-1' },
      sending: { 'gateway:shared-id': true },
    });
    mockApi.chatGetMessages.mockResolvedValue({
      items: [message('canonical-user', ref), assistant],
      nextCursor: null,
      throughSeq: 2,
    });
    mockApi.chatGetConversation.mockResolvedValue({
      ...gatewayConversation,
      revision: 3,
      lastSeq: 2,
    });

    await useChatStore.getState().applyFrame({
      type: 'done',
      id: 'turn-1',
      conversationId: ref.id,
      seq: 2,
      outcome: 'completed',
    });

    expect(useChatStore.getState().messages['gateway:shared-id'][1].id).toBe(assistant.id);
    expect(useChatStore.getState().sending['gateway:shared-id']).toBe(false);
    expect(useChatStore.getState().localTurnIds['gateway:shared-id']).toBeUndefined();
  });

  it('refetches a changed conversation and subscribes its active turn through the exact ref', async () => {
    const ref = { id: gatewayConversation.id, origin: 'gateway' as const };
    const running = {
      ...gatewayConversation,
      status: 'running' as const,
      activeTurnId: 'ios-turn',
    };
    mockApi.chatGetConversation.mockResolvedValue(running);
    mockApi.chatGetMessages.mockResolvedValue({ items: [], nextCursor: null, throughSeq: 4 });

    await useChatStore.getState().invalidateConversation({ type: 'changed', conversation: ref });

    expect(mockApi.chatGetConversation).toHaveBeenCalledWith(ref);
    expect(mockApi.chatGetMessages).toHaveBeenCalledWith(ref, undefined);
    expect(useChatStore.getState().conversations).toContainEqual(running);
  });

  it('refreshes list authority and passive locks for gateway lifecycle invalidations', async () => {
    const wildcard = { id: '*', origin: 'gateway' as const };
    useChatStore.setState({
      conversations: [gatewayConversation],
      gatewayOnline: true,
      conversationAuthority: 'gateway',
    });
    mockApi.chatListConversations
      .mockResolvedValueOnce({
        items: [{ ...gatewayConversation, offline: true, readOnly: true }],
        nextCursor: null,
        authority: 'gateway',
        gatewayOnline: false,
      })
      .mockResolvedValueOnce({
        items: [gatewayConversation],
        nextCursor: null,
        authority: 'gateway',
        gatewayOnline: true,
      });

    await useChatStore
      .getState()
      .invalidateConversation({ type: 'changed', conversation: wildcard });
    expect(useChatStore.getState()).toMatchObject({
      gatewayOnline: false,
      conversations: [{ offline: true, readOnly: true }],
    });

    await useChatStore
      .getState()
      .invalidateConversation({ type: 'changed', conversation: wildcard });
    expect(useChatStore.getState()).toMatchObject({
      gatewayOnline: true,
      conversations: [{ offline: false, readOnly: false }],
    });
    expect(mockApi.chatGetConversation).not.toHaveBeenCalled();
  });

  it('ignores a delayed stale summary after a newer invalidation fetch resolves', async () => {
    const ref = { id: gatewayConversation.id, origin: 'gateway' as const };
    const stale = deferred<McConversationView | null>();
    const current = deferred<McConversationView | null>();
    mockApi.chatGetConversation
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(current.promise);

    const staleRefresh = useChatStore
      .getState()
      .invalidateConversation({ type: 'changed', conversation: ref });
    const currentRefresh = useChatStore
      .getState()
      .invalidateConversation({ type: 'changed', conversation: ref });
    current.resolve({ ...gatewayConversation, revision: 5, title: 'Current title' });
    await currentRefresh;
    stale.resolve({ ...gatewayConversation, revision: 3, title: 'Stale title' });
    await staleRefresh;

    expect(useChatStore.getState().conversations[0]).toMatchObject({
      revision: 5,
      title: 'Current title',
    });
  });

  it('deletes only the matching origin and preserves same-ID local state', async () => {
    const gatewayRef = { id: 'shared-id', origin: 'gateway' as const };
    useChatStore.setState({
      conversations: [gatewayConversation, localConversation],
      selectedConversationRef: gatewayRef,
      openTabKeys: ['gateway:shared-id', 'local:shared-id'],
      messages: {
        'gateway:shared-id': [message('gateway-message', gatewayRef)],
        'local:shared-id': [message('local-message', { ...gatewayRef, origin: 'local' })],
      },
    });

    await useChatStore
      .getState()
      .invalidateConversation({ type: 'deleted', conversation: gatewayRef });

    expect(useChatStore.getState().conversations).toEqual([localConversation]);
    expect(useChatStore.getState().messages['gateway:shared-id']).toBeUndefined();
    expect(useChatStore.getState().messages['local:shared-id']).toHaveLength(1);
    expect(useChatStore.getState().openTabKeys).toEqual(['local:shared-id']);
  });

  it('reconciles a revision conflict and leaves rename available for retry', async () => {
    const ref = { id: gatewayConversation.id, origin: 'gateway' as const };
    const current = { ...gatewayConversation, revision: 4, title: 'Concurrent title' };
    useChatStore.setState({
      conversations: [gatewayConversation],
      gatewayOnline: true,
      conversationAuthority: 'gateway',
    });
    mockApi.chatRenameConversation.mockRejectedValue({
      code: 'revision_conflict',
      details: { current },
    });

    await expect(useChatStore.getState().renameConversation(ref, 'My title')).rejects.toBeDefined();

    expect(useChatStore.getState().conversations[0]).toMatchObject(current);
    expect(useChatStore.getState().conversations[0].readOnly).toBe(false);
  });

  it('retains cached content and marks mutations read-only after an offline error', async () => {
    const ref = { id: gatewayConversation.id, origin: 'gateway' as const };
    useChatStore.setState({
      conversations: [gatewayConversation],
      messages: { 'gateway:shared-id': [message('cached', ref)] },
      gatewayOnline: true,
      conversationAuthority: 'gateway',
    });
    mockApi.chatRenameConversation.mockRejectedValue({ code: 'gateway_offline' });

    await expect(useChatStore.getState().renameConversation(ref, 'Offline')).rejects.toBeDefined();

    expect(useChatStore.getState().messages['gateway:shared-id'][0].id).toBe('cached');
    expect(useChatStore.getState().gatewayOnline).toBe(false);
    expect(useChatStore.getState().conversations[0]).toMatchObject({
      offline: true,
      readOnly: true,
    });
  });

  it('preserves a repair-required connection issue separately from gateway offline', () => {
    useChatStore.setState({ gatewayOnline: false });
    const issue = {
      conversation: { id: '*', origin: 'gateway' as const },
      kind: 'repair_required' as const,
      message: 'Gateway authorization failed. Reconnect this gateway to continue.',
      retryable: false,
    };

    useChatStore.getState().handleConnectionIssue(issue);

    expect(useChatStore.getState().connectionIssue).toEqual(issue);
    expect(useChatStore.getState().conversationError).toBe(issue.message);
    expect(useChatStore.getState().gatewayOnline).toBe(false);
  });

  it.each([
    ['archived', { status: 'archived' as const, activeTurnId: null }],
    ['locally running', { status: 'running' as const, activeTurnId: 'local-turn' }],
    ['remotely running', { status: 'running' as const, activeTurnId: 'ios-turn' }],
  ])('blocks rename and delete for %s history without issuing IPC', async (_label, patch) => {
    const ref = { id: gatewayConversation.id, origin: 'gateway' as const };
    useChatStore.setState({
      conversations: [{ ...gatewayConversation, ...patch }],
      localTurnIds:
        patch.activeTurnId === 'local-turn' ? { 'gateway:shared-id': 'local-turn' } : {},
      gatewayOnline: true,
      conversationAuthority: 'gateway',
    });

    await expect(useChatStore.getState().renameConversation(ref, 'Blocked')).rejects.toThrow();
    await expect(useChatStore.getState().deleteConversation(ref)).rejects.toThrow();

    expect(mockApi.chatRenameConversation).not.toHaveBeenCalled();
    expect(mockApi.chatDeleteConversation).not.toHaveBeenCalled();
  });

  it('cancels a remote turn with the canonical active turn ID', () => {
    const ref = { id: gatewayConversation.id, origin: 'gateway' as const };
    useChatStore.setState({
      conversations: [{ ...gatewayConversation, status: 'running', activeTurnId: 'remote-turn' }],
      localTurnIds: {},
      sending: {},
      gatewayOnline: true,
    });

    useChatStore.getState().cancelMessage(ref);

    expect(mockApi.chatCancel).toHaveBeenCalledWith(ref, 'remote-turn');
  });

  it('preserves local cancellation through its canonical active turn', () => {
    const ref = { id: gatewayConversation.id, origin: 'gateway' as const };
    useChatStore.setState({
      conversations: [{ ...gatewayConversation, status: 'running', activeTurnId: 'local-turn' }],
      localTurnIds: { 'gateway:shared-id': 'local-turn' },
      sending: { 'gateway:shared-id': true },
      gatewayOnline: true,
    });

    useChatStore.getState().cancelMessage(ref);

    expect(mockApi.chatCancel).toHaveBeenCalledWith(ref, 'local-turn');
    expect(useChatStore.getState().sending['gateway:shared-id']).toBe(false);
  });

  /**
   * D3 — the composer wedged with no way out.
   *
   * `sending[key]` is set optimistically by `sendMessage` and cleared ONLY by
   * `refreshTerminal`, which runs only from a `done`/`error` frame or a seq
   * gap. Lose that frame — which is exactly what D5's `invalidFrame()` did to
   * every turn that spawned a child — and a later authoritative read then puts
   * `activeTurnId` back to `null`. The composer is locked on
   * `activeTurnId !== null || sending[key]`, the Stop control renders on
   * `activeTurnId` ALONE, and those two predicates disagree: disabled
   * composer, disabled Send, no Stop, gateway idle, reload the only exit.
   */
  it('cancels a locally-stuck turn the server no longer considers active', () => {
    const ref = { id: gatewayConversation.id, origin: 'gateway' as const };
    useChatStore.setState({
      // What the server says: idle. What the renderer still believes: sending.
      conversations: [{ ...gatewayConversation, status: 'idle', activeTurnId: null }],
      localTurnIds: {},
      sending: { 'gateway:shared-id': true },
      streamingFrames: {
        'gateway:shared-id': [
          {
            type: 'event',
            id: 'lost-turn',
            conversationId: gatewayConversation.id,
            seq: 2,
            event: { type: 'text_delta', text: 'half a turn' },
          },
        ],
      },
      gatewayOnline: true,
    });

    useChatStore.getState().cancelMessage(ref);

    // Nothing to cancel on the server, and that is the point: the local
    // wedge must still clear, because it is the only thing still locking the
    // composer.
    expect(mockApi.chatCancel).not.toHaveBeenCalled();
    expect(useChatStore.getState().sending['gateway:shared-id']).toBe(false);
    expect(useChatStore.getState().streamingFrames['gateway:shared-id']).toEqual([]);
  });

  /**
   * D9 — "cancelling a turn leaves the child's card spinning with a ticking
   * clock", filed as a second mechanism. It is a CONSEQUENCE of D5.
   *
   * A card resolves `running` while `isStreaming`, and `isStreaming` follows
   * `streamingFrames[key]`, which only `refreshTerminal` empties — and
   * `refreshTerminal` runs only from the turn's `done`/`error` frame. X1's
   * `sleep 200` child emitted a heartbeat at 10s, D5's `invalidFrame()`
   * terminalized the turn on it, and no `done` ever arrived: the cards had
   * nothing to end them. The pinned strip vanished anyway because it reads the
   * purely local `sending`, which `cancelMessage` clears synchronously — which
   * is exactly why the report says "the fold believed the stream had ended".
   *
   * This pins the repaired path end to end: cancel, then the `done` the
   * transport can now deliver, and the live stream is gone.
   */
  it('ends the live stream when a cancelled turn reaches its done frame', async () => {
    const ref = { id: gatewayConversation.id, origin: 'gateway' as const };
    const key = 'gateway:shared-id';
    const running = { ...gatewayConversation, status: 'running' as const, activeTurnId: 'turn-9' };
    mockApi.chatGetConversation.mockResolvedValue({
      ...running,
      status: 'idle',
      activeTurnId: null,
    });
    mockApi.chatGetMessages.mockResolvedValue({ items: [], nextCursor: null, throughSeq: 3 });
    useChatStore.setState({
      conversations: [running],
      localTurnIds: { [key]: 'turn-9' },
      sending: { [key]: true },
      lastSeq: { [key]: 2 },
      streamingFrames: {
        [key]: [
          {
            type: 'event',
            id: 'turn-9',
            conversationId: ref.id,
            seq: 2,
            event: {
              type: 'subagent_started',
              subagentId: 'sub_slow',
              subagentType: 'general-purpose',
              description: 'sleep 200',
              startedAt: '2026-09-09T00:00:00.000Z',
            },
          },
        ],
      },
      gatewayOnline: true,
    });

    useChatStore.getState().cancelMessage(ref);
    expect(mockApi.chatCancel).toHaveBeenCalledWith(ref, 'turn-9');

    await useChatStore.getState().applyFrame({
      type: 'done',
      id: 'turn-9',
      conversationId: ref.id,
      seq: 3,
      outcome: 'cancelled',
    });

    // No live frames left, so the fold's end-of-stream terminalization runs and
    // the card can no longer resolve `running` (§31.9.2). §32.2.2's frozen
    // meta follows from the same fact.
    expect(useChatStore.getState().streamingFrames[key]).toEqual([]);
    expect(useChatStore.getState().sending[key]).toBe(false);
  });

  it('contains rejected invalidation listener work instead of detaching an unhandled promise', async () => {
    let listener!: (event: {
      type: 'changed';
      conversation: { id: string; origin: 'gateway' };
    }) => void;
    mockApi.onChatConversationInvalidated.mockImplementation((callback) => {
      listener = callback;
      return () => undefined;
    });
    const original = useChatStore.getState().invalidateConversation;
    const rejected = vi.fn().mockRejectedValue(new Error('refresh failed'));
    useChatStore.setState({ invalidateConversation: rejected });

    initChatListeners();
    listener({ type: 'changed', conversation: { id: '*', origin: 'gateway' } });
    await Promise.resolve();
    await Promise.resolve();

    expect(rejected).toHaveBeenCalledOnce();
    useChatStore.setState({ invalidateConversation: original });
  });

  /**
   * D7b M3. `onSubagentResubscribed` and `onSubagentWatchLost` are both
   * `(id: string) => void`, so a SWAP between them typechecks and ships green
   * while inverting the whole C2 fix: a drop would turn optimism ON and force
   * a re-read, a recovery would turn it OFF. The IPC seam covers main→preload
   * only; this is the renderer half, driven through the callbacks
   * `initChatListeners` actually registered.
   *
   * `initialized` is module-level, so the `initChatListeners()` call above is
   * this file's only registration and `mock.calls[0]` is it.
   */
  it('wires the two child-watch callbacks to the right store actions', async () => {
    // The module-level `initialized` flag means only the FIRST call in a
    // module instance registers, and `beforeEach`'s `restoreAllMocks` has
    // already cleared whatever an earlier test registered. A fresh module is
    // the only way to observe the registration itself.
    vi.resetModules();
    const fresh = await import('./chat.js');
    fresh.initChatListeners();

    const onRestored = mockApi.onSubagentResubscribed.mock.calls.at(-1)?.[0];
    const onLost = mockApi.onSubagentWatchLost.mock.calls.at(-1)?.[0];
    expect(typeof onRestored).toBe('function');
    expect(typeof onLost).toBe('function');

    fresh.useChatStore.setState({
      conversations: [gatewayConversation],
      selectedConversationRef: { id: gatewayConversation.id, origin: 'gateway' },
    });
    fresh.useChatStore.getState().subscribeSubagent('sub_a');
    expect(fresh.useChatStore.getState().isSubagentSubscribed('sub_a')).toBe(true);

    // LOST stops optimism and reads nothing.
    mockApi.subagentsList.mockClear();
    onLost?.('sub_a');
    expect(fresh.useChatStore.getState().isSubagentSubscribed('sub_a')).toBe(false);
    expect(mockApi.subagentsList).not.toHaveBeenCalled();

    // RESTORED puts optimism back AND goes to the server for what it missed.
    onRestored?.('sub_a');
    await Promise.resolve();
    expect(fresh.useChatStore.getState().isSubagentSubscribed('sub_a')).toBe(true);
    expect(mockApi.subagentsList).toHaveBeenCalled();
  });
});

// --- Sub-agents (design §7.7, §8.1, §8.4) ------------------------------------

function subagentEntry(over: Partial<SubagentListEntry> = {}): SubagentListEntry {
  return {
    id: 'sub_a',
    type: 'code-reviewer',
    description: 'Review the diff',
    status: 'running',
    background: false,
    depth: 1,
    startedAt: '2026-09-04T00:00:00.000Z',
    toolCallCount: 4,
    oneShot: false,
    ...over,
  };
}

const parentRef: ConversationRef = { id: 'shared-id', origin: 'gateway' };

async function selectParent(): Promise<void> {
  useChatStore.setState({ selectedConversationRef: parentRef });
}

describe('sub-agent list reads', () => {
  it("reads the selected conversation's children", async () => {
    await selectParent();
    mockApi.subagentsList.mockResolvedValue([subagentEntry()]);

    await useChatStore.getState().refreshSubagents();

    expect(mockApi.subagentsList).toHaveBeenCalledWith('shared-id');
    expect(useChatStore.getState().subagents).toEqual([subagentEntry()]);
  });

  // An "On this Mac" conversation has no gateway row and therefore no children.
  // Asking for them is a guaranteed failing HTTP call on every selection.
  it('does not ask the gateway for the children of a local conversation', async () => {
    useChatStore.setState({
      selectedConversationRef: { id: 'legacy-1', origin: 'local' },
      subagents: [subagentEntry()],
    });

    await useChatStore.getState().refreshSubagents();

    expect(mockApi.subagentsList).not.toHaveBeenCalled();
    expect(useChatStore.getState().subagents).toEqual([]);
  });

  it('empties the list when nothing is selected', async () => {
    useChatStore.setState({ subagents: [subagentEntry()], selectedConversationRef: null });

    await useChatStore.getState().refreshSubagents();

    expect(useChatStore.getState().subagents).toEqual([]);
    expect(mockApi.subagentsList).not.toHaveBeenCalled();
  });

  // Guard 1 of the two the read carries (ported from the web port's D3 round).
  it('drops a response for the conversation the user has already left', async () => {
    await selectParent();
    const pending = deferred<SubagentListEntry[]>();
    mockApi.subagentsList.mockReturnValue(pending.promise);

    const read = useChatStore.getState().refreshSubagents();
    useChatStore.setState({ selectedConversationRef: { id: 'other', origin: 'gateway' } });
    pending.resolve([subagentEntry()]);
    await read;

    expect(useChatStore.getState().subagents).toEqual([]);
  });

  // Guard 2: a monotonic applied cursor, so the NEWEST read wins whichever
  // order the two responses come back in.
  it('does not let a stale read overwrite a newer one that landed first', async () => {
    await selectParent();
    const first = deferred<SubagentListEntry[]>();
    const second = deferred<SubagentListEntry[]>();
    mockApi.subagentsList.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const readA = useChatStore.getState().refreshSubagents();
    const readB = useChatStore.getState().refreshSubagents();
    second.resolve([subagentEntry({ status: 'done' })]);
    await readB;
    first.resolve([subagentEntry({ status: 'running' })]);
    await readA;

    expect(useChatStore.getState().subagents[0].status).toBe('done');
  });

  it('clears both the children and their card state on a conversation switch', async () => {
    mockApi.chatGetConversation.mockResolvedValue(gatewayConversation);
    mockApi.chatGetMessages.mockResolvedValue({ items: [], nextCursor: null, throughSeq: 0 });
    useChatStore.setState({
      subagents: [subagentEntry()],
      subagentUi: {
        sub_a: {
          expanded: true,
          groupCollapsed: false,
          draft: 'half a sentence',
          notice: null,
          sending: false,
          transcriptLoaded: true,
        },
      },
    });

    await useChatStore.getState().selectConversation(parentRef);

    expect(useChatStore.getState().subagents).toEqual([]);
    expect(useChatStore.getState().subagentUi).toEqual({});
  });

  it('reads the children on every conversation selection, live turn or not', async () => {
    mockApi.chatGetConversation.mockResolvedValue(gatewayConversation);
    mockApi.chatGetMessages.mockResolvedValue({ items: [], nextCursor: null, throughSeq: 0 });
    mockApi.subagentsList.mockResolvedValue([subagentEntry({ background: true })]);

    await useChatStore.getState().selectConversation(parentRef);

    expect(mockApi.subagentsList).toHaveBeenCalledWith('shared-id');
    expect(useChatStore.getState().subagents).toHaveLength(1);
  });

  it('makes an in-flight read of the previous conversation inert', async () => {
    await selectParent();
    mockApi.chatGetConversation.mockResolvedValue(gatewayConversation);
    mockApi.chatGetMessages.mockResolvedValue({ items: [], nextCursor: null, throughSeq: 0 });
    const pending = deferred<SubagentListEntry[]>();
    // Only the FIRST read hangs; the selection's own read answers empty, which
    // is what the stale response must not be able to overwrite.
    mockApi.subagentsList.mockReturnValueOnce(pending.promise).mockResolvedValue([]);

    const read = useChatStore.getState().refreshSubagents();
    await useChatStore.getState().selectConversation(parentRef);
    pending.resolve([subagentEntry()]);
    await read;

    expect(useChatStore.getState().subagents).toEqual([]);
  });

  // Guard 3, the cursor bump in `clearSubagents`, on the one selection that
  // reaches it alone. The test above cannot fail without the bump: it
  // re-selects the SAME gateway ref, so the selection's own trailing
  // `refreshSubagents()` takes a fresh sequence number and writes the cursor
  // itself. Selecting the LOCAL tab of the same id returns early at
  // `ref.origin !== 'gateway'` BEFORE the cursor is touched, so the bump in
  // `clearSubagents` is the only thing between the gateway conversation's
  // children and the local conversation's transcript.
  it('keeps a gateway read in flight off the local tab that shares its id', async () => {
    const gatewayRef = { id: 'shared-id', origin: 'gateway' as const };
    const localRef = { id: 'shared-id', origin: 'local' as const };
    useChatStore.setState({
      selectedConversationRef: gatewayRef,
      conversations: [gatewayConversation, localConversation],
      conversationAuthority: 'gateway',
      gatewayOnline: true,
    });
    mockApi.chatGetMessages.mockResolvedValue({ items: [], nextCursor: null, throughSeq: 0 });
    const pending = deferred<SubagentListEntry[]>();
    mockApi.subagentsList.mockReturnValue(pending.promise);

    const read = useChatStore.getState().refreshSubagents();
    await useChatStore.getState().selectConversation(localRef);
    pending.resolve([subagentEntry()]);
    await read;

    expect(useChatStore.getState().selectedConversationRef).toEqual(localRef);
    expect(useChatStore.getState().subagents).toEqual([]);
  });

  // Closing the selected tab switches conversation without going through
  // `selectConversation`, and the list and its card state describe ONE
  // conversation. The panel renders that list raw, so without this it shows
  // the closed conversation's children — and, since the poll only runs while
  // one of them is live, possibly for as long as the new tab is open.
  it("forgets the closed conversation's children and reads the new selection's", async () => {
    useChatStore.setState({
      selectedConversationRef: parentRef,
      openTabKeys: ['gateway:shared-id', 'gateway:other'],
      subagents: [subagentEntry()],
      subagentUi: {
        sub_a: {
          expanded: true,
          groupCollapsed: false,
          draft: 'half a sentence',
          notice: null,
          sending: false,
          transcriptLoaded: true,
        },
      },
    });
    mockApi.subagentsList.mockResolvedValue([subagentEntry({ id: 'sub_b' })]);

    useChatStore.getState().closeTab('gateway:shared-id');

    expect(useChatStore.getState().subagents).toEqual([]);
    expect(useChatStore.getState().subagentUi).toEqual({});
    await Promise.resolve();
    await Promise.resolve();
    expect(mockApi.subagentsList).toHaveBeenCalledWith('other');
    expect(useChatStore.getState().subagents).toEqual([subagentEntry({ id: 'sub_b' })]);
  });

  // `purgeConversation` is the OTHER path that changes the selection without
  // going through `selectConversation` — it runs the same `selectedAfterRemoval`
  // — and it is worse than `closeTab` was: `subagents` keeps its identity, so
  // the 20 s poll is not armed, and with every child terminal the dead
  // conversation's children stay on screen until something else re-reads.
  it("forgets a deleted conversation's children and reads the new selection's", async () => {
    useChatStore.setState({
      conversations: [gatewayConversation, { ...gatewayConversation, id: 'other' }],
      conversationAuthority: 'gateway',
      gatewayOnline: true,
      selectedConversationRef: parentRef,
      openTabKeys: ['gateway:shared-id', 'gateway:other'],
      subagents: [subagentEntry({ status: 'done' })],
      subagentUi: {
        sub_a: {
          expanded: true,
          groupCollapsed: false,
          draft: 'half a sentence',
          notice: null,
          sending: false,
          transcriptLoaded: true,
        },
      },
    });
    mockApi.chatDeleteConversation.mockResolvedValue(undefined);
    mockApi.subagentsList.mockResolvedValue([subagentEntry({ id: 'sub_b' })]);

    await useChatStore.getState().deleteConversation(parentRef);

    expect(useChatStore.getState().subagentUi).toEqual({});
    await Promise.resolve();
    await Promise.resolve();
    expect(mockApi.subagentsList).toHaveBeenCalledWith('other');
    expect(useChatStore.getState().subagents).toEqual([subagentEntry({ id: 'sub_b' })]);
  });

  // The same switch arrives unprompted when another client deletes the
  // conversation: the gateway pushes an invalidation and the store purges.
  it('forgets the children when the gateway says the conversation is gone', async () => {
    useChatStore.setState({
      conversations: [gatewayConversation, { ...gatewayConversation, id: 'other' }],
      conversationAuthority: 'gateway',
      gatewayOnline: true,
      selectedConversationRef: parentRef,
      openTabKeys: ['gateway:shared-id', 'gateway:other'],
      subagents: [subagentEntry({ status: 'done' })],
    });
    mockApi.subagentsList.mockResolvedValue([subagentEntry({ id: 'sub_b' })]);

    await useChatStore
      .getState()
      .invalidateConversation({ type: 'deleted', conversation: parentRef });

    await Promise.resolve();
    await Promise.resolve();
    expect(mockApi.subagentsList).toHaveBeenCalledWith('other');
    expect(useChatStore.getState().subagents).toEqual([subagentEntry({ id: 'sub_b' })]);
  });

  // …and the purge's re-read goes through D3's guards like every other one:
  // switch again while it is in flight and the stale response is dropped.
  it("drops the purge's re-read when the user has moved on again", async () => {
    useChatStore.setState({
      conversations: [gatewayConversation, { ...gatewayConversation, id: 'other' }],
      conversationAuthority: 'gateway',
      gatewayOnline: true,
      selectedConversationRef: parentRef,
      openTabKeys: ['gateway:shared-id', 'gateway:other'],
      subagents: [subagentEntry()],
    });
    // The purge's own read hangs; the selection that overtakes it answers.
    const pending = deferred<SubagentListEntry[]>();
    mockApi.subagentsList.mockImplementation((id: string) =>
      id === 'other' ? pending.promise : Promise.resolve([subagentEntry({ id: 'sub_c' })]),
    );
    mockApi.chatGetConversation.mockResolvedValue({ ...gatewayConversation, id: 'third' });
    mockApi.chatGetMessages.mockResolvedValue({ items: [], nextCursor: null, throughSeq: 0 });

    await useChatStore
      .getState()
      .invalidateConversation({ type: 'deleted', conversation: parentRef });
    await useChatStore.getState().selectConversation({ id: 'third', origin: 'gateway' });
    pending.resolve([subagentEntry({ id: 'sub_b' })]);
    await Promise.resolve();
    await Promise.resolve();

    expect(mockApi.subagentsList.mock.calls.map((call) => call[0])).toEqual(['other', 'third']);
    expect(useChatStore.getState().subagents).toEqual([subagentEntry({ id: 'sub_c' })]);
  });

  // Deleting a conversation that is NOT selected changes nothing about whose
  // children are on screen, so it must not clear or re-read.
  it('leaves the children alone when the conversation deleted was not selected', async () => {
    useChatStore.setState({
      conversations: [gatewayConversation, { ...gatewayConversation, id: 'other' }],
      conversationAuthority: 'gateway',
      gatewayOnline: true,
      selectedConversationRef: parentRef,
      openTabKeys: ['gateway:shared-id', 'gateway:other'],
      subagents: [subagentEntry()],
    });

    await useChatStore.getState().invalidateConversation({
      type: 'deleted',
      conversation: { id: 'other', origin: 'gateway' },
    });

    await Promise.resolve();
    expect(useChatStore.getState().subagents).toEqual([subagentEntry()]);
    expect(mockApi.subagentsList).not.toHaveBeenCalled();
  });

  // …and only then: closing a background tab leaves the selection, and
  // therefore the children on screen, exactly where they were.
  it('leaves the children alone when the tab closed was not the selected one', async () => {
    useChatStore.setState({
      selectedConversationRef: parentRef,
      openTabKeys: ['gateway:shared-id', 'gateway:other'],
      subagents: [subagentEntry()],
    });

    useChatStore.getState().closeTab('gateway:other');

    await Promise.resolve();
    expect(useChatStore.getState().subagents).toEqual([subagentEntry()]);
    expect(mockApi.subagentsList).not.toHaveBeenCalled();
  });
});

describe('sub-agent list triggers', () => {
  function eventFrame(type: string): MobileWsServerFrame {
    return {
      type: 'event',
      id: 'turn-1',
      conversationId: 'shared-id',
      seq: 1,
      event: { type, subagentId: 'sub_a' },
    } as unknown as MobileWsServerFrame;
  }

  it('re-reads the list when a child starts or finishes on the open conversation', async () => {
    await selectParent();
    await useChatStore.getState().applyFrame(eventFrame('subagent_started'));
    await useChatStore.getState().applyFrame(eventFrame('subagent_finished'));
    await Promise.resolve();

    expect(mockApi.subagentsList).toHaveBeenCalledTimes(2);
  });

  it('does not re-read on every progress event', async () => {
    await selectParent();
    await useChatStore.getState().applyFrame(eventFrame('subagent_progress'));
    await Promise.resolve();

    expect(mockApi.subagentsList).not.toHaveBeenCalled();
  });

  it('does not re-read for a conversation that is not the open one', async () => {
    useChatStore.setState({ selectedConversationRef: { id: 'other', origin: 'gateway' } });
    await useChatStore.getState().applyFrame(eventFrame('subagent_started'));
    await Promise.resolve();

    expect(mockApi.subagentsList).not.toHaveBeenCalled();
  });
});

describe('sub-agent live poll', () => {
  // The poll used to live in `SwarmPanel`, so it ran only while the panel was
  // open — and an expanded card of a background child in a reopened
  // conversation had no refresh trigger at all until somebody opened it. It
  // follows the children now, so it runs panel or not.
  it('re-reads while a child is live and stops once they are all terminal', async () => {
    vi.useFakeTimers();
    try {
      mockApi.subagentsList.mockResolvedValue([subagentEntry({ status: 'running' })]);
      useChatStore.setState({
        selectedConversationRef: parentRef,
        subagents: [subagentEntry({ status: 'running' })],
      });

      await vi.advanceTimersByTimeAsync(20_000);
      expect(mockApi.subagentsList).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(mockApi.subagentsList).toHaveBeenCalledTimes(2);

      mockApi.subagentsList.mockResolvedValue([subagentEntry({ status: 'done' })]);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(mockApi.subagentsList).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(mockApi.subagentsList).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('sub-agent card state', () => {
  it('keeps the card facts and the card UI in separate records', async () => {
    await selectParent();
    mockApi.subagentsList.mockResolvedValue([subagentEntry({ status: 'done' })]);
    useChatStore.getState().toggleSubagent('sub_a');
    useChatStore.getState().setSubagentDraft('sub_a', 'half a sentence');

    await useChatStore.getState().refreshSubagents();

    // A list read REPLACES the facts wholesale. It cannot lose a card's
    // expansion or its half-typed reply, because it does not write that record
    // at all — which is why there is no merge to get wrong.
    expect(useChatStore.getState().subagents[0].status).toBe('done');
    expect(useChatStore.getState().subagentUi.sub_a).toMatchObject({
      expanded: true,
      draft: 'half a sentence',
    });
  });

  it('fetches a child transcript once, and again only when forced', async () => {
    mockApi.conversationMessages.mockResolvedValue({
      items: [message('m1', { id: 'sub_a', origin: 'gateway' }, 'assistant')],
      nextCursor: null,
      throughSeq: 0,
    });

    await useChatStore.getState().loadSubagentTranscript('sub_a');
    await useChatStore.getState().loadSubagentTranscript('sub_a');

    expect(mockApi.conversationMessages).toHaveBeenCalledTimes(1);
    expect(useChatStore.getState().subagentUi.sub_a.transcript).toHaveLength(1);

    await useChatStore.getState().loadSubagentTranscript('sub_a', true);
    expect(mockApi.conversationMessages).toHaveBeenCalledTimes(2);
  });

  // The route returns a page ordered by `ordinal ASC`, but a card that renders
  // `page.items` verbatim depends on that silently — and the parent transcript
  // does not (it runs every page through `mergeCanonicalMessages`).
  it('orders a child transcript by ordinal, whatever order the page arrives in', async () => {
    const child = { id: 'sub_a', origin: 'gateway' as const };
    mockApi.conversationMessages.mockResolvedValue({
      items: [
        { ...message('m2', child, 'assistant'), ordinal: 2 },
        { ...message('m1', child, 'user'), ordinal: 1 },
      ],
      nextCursor: null,
      throughSeq: 0,
    });

    await useChatStore.getState().loadSubagentTranscript('sub_a');

    expect(useChatStore.getState().subagentUi.sub_a.transcript?.map((m) => m.id)).toEqual([
      'm1',
      'm2',
    ]);
  });

  it('puts a failed transcript fetch on the card rather than throwing', async () => {
    mockApi.conversationMessages.mockRejectedValue(new Error('gateway offline'));

    await useChatStore.getState().loadSubagentTranscript('sub_a');

    expect(useChatStore.getState().subagentUi.sub_a.notice).toContain('gateway offline');
  });
});

describe('sub-agent stop', () => {
  it('re-reads the list after a stop', async () => {
    await selectParent();
    mockApi.subagentsList.mockResolvedValue([subagentEntry({ status: 'cancelled' })]);

    await useChatStore.getState().stopSubagent('sub_a');

    expect(mockApi.subagentStop).toHaveBeenCalledWith('sub_a');
    expect(useChatStore.getState().subagents[0].status).toBe('cancelled');
  });

  it('puts a refused stop on the card and still re-reads', async () => {
    await selectParent();
    mockApi.subagentStop.mockResolvedValue({
      ok: false,
      reason: 'Sub-agent sub_a is already done',
    });
    mockApi.subagentsList.mockResolvedValue([subagentEntry({ status: 'done' })]);

    await useChatStore.getState().stopSubagent('sub_a');

    expect(useChatStore.getState().subagentUi.sub_a.notice).toBe('Sub-agent sub_a is already done');
    expect(useChatStore.getState().subagents[0].status).toBe('done');
  });
});

describe('sub-agent resume', () => {
  it('carries a client requestId and clears the draft on success', async () => {
    await selectParent();
    useChatStore.getState().setSubagentDraft('sub_a', 'keep going');

    const ok = await useChatStore.getState().resumeSubagent('sub_a', 'keep going');

    expect(ok).toBe(true);
    const [id, message_, requestId] = mockApi.subagentResume.mock.calls[0];
    expect(id).toBe('sub_a');
    expect(message_).toBe('keep going');
    expect(typeof requestId).toBe('string');
    expect((requestId as string).length).toBeGreaterThan(0);
    expect(useChatStore.getState().subagentUi.sub_a.draft).toBe('');
    expect(useChatStore.getState().subagentUi.sub_a.sending).toBe(false);
  });

  // Ruling 3: without this, every surface holds the child's PRE-resume status
  // for the whole new run — outside a live parent turn no child event reaches
  // the parent at all.
  it('re-reads the list after a resume, so the row describes the new run', async () => {
    await selectParent();
    mockApi.subagentsList.mockResolvedValue([
      subagentEntry({ status: 'running', toolCallCount: 0 }),
    ]);
    useChatStore.setState({ subagents: [subagentEntry({ status: 'done', toolCallCount: 12 })] });

    await useChatStore.getState().resumeSubagent('sub_a', 'keep going');

    expect(mockApi.subagentsList).toHaveBeenCalled();
    expect(useChatStore.getState().subagents[0]).toMatchObject({
      status: 'running',
      toolCallCount: 0,
    });
  });

  it('re-fetches an OPEN child transcript after a resume, and leaves a closed one alone', async () => {
    await selectParent();
    mockApi.conversationMessages.mockResolvedValue({
      items: [],
      nextCursor: null,
      throughSeq: 0,
    });
    await useChatStore.getState().loadSubagentTranscript('sub_a');
    expect(mockApi.conversationMessages).toHaveBeenCalledTimes(1);

    await useChatStore.getState().resumeSubagent('sub_a', 'keep going');
    expect(mockApi.conversationMessages).toHaveBeenCalledTimes(2);

    await useChatStore.getState().resumeSubagent('sub_b', 'keep going');
    expect(mockApi.conversationMessages).toHaveBeenCalledTimes(2);
  });

  it('keeps the draft and surfaces the reason when the gateway refuses', async () => {
    await selectParent();
    useChatStore.getState().setSubagentDraft('sub_a', 'keep going');
    mockApi.subagentResume.mockResolvedValue({
      ok: false,
      reason: 'sub-agent type Explore is one-shot and cannot be resumed',
    });

    const ok = await useChatStore.getState().resumeSubagent('sub_a', 'keep going');

    expect(ok).toBe(false);
    expect(useChatStore.getState().subagentUi.sub_a).toMatchObject({
      draft: 'keep going',
      sending: false,
      notice: 'sub-agent type Explore is one-shot and cannot be resumed',
    });
  });

  it('surfaces a thrown resume as a notice rather than an unhandled rejection', async () => {
    await selectParent();
    mockApi.subagentResume.mockRejectedValue(new Error('Management API error 404: nope'));

    const ok = await useChatStore.getState().resumeSubagent('sub_a', 'keep going');

    expect(ok).toBe(false);
    expect(useChatStore.getState().subagentUi.sub_a.notice).toContain('404');
  });

  it('dismisses a notice on request', async () => {
    await selectParent();
    mockApi.subagentStop.mockResolvedValue({ ok: false, reason: 'already done' });
    await useChatStore.getState().stopSubagent('sub_a');
    expect(useChatStore.getState().subagentUi.sub_a.notice).toBe('already done');

    useChatStore.getState().dismissSubagentNotice('sub_a');

    expect(useChatStore.getState().subagentUi.sub_a.notice).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Live child transcripts (design §8.3) — task D7b
// ---------------------------------------------------------------------------

const childRef: ConversationRef = { id: 'sub_a', origin: 'gateway' };

async function selectParentWithAgent(): Promise<void> {
  useChatStore.setState({
    selectedConversationRef: parentRef,
    conversations: [gatewayConversation],
  });
}

function accepted(over: Partial<Record<string, unknown>> = {}): MobileWsServerFrame {
  return {
    type: 'accepted',
    id: 'child-turn-1',
    conversationId: 'sub_a',
    userMessageId: 'child-user-1',
    assistantMessageId: 'child-assistant-1',
    revision: 3,
    seq: 41,
    ...over,
  } as MobileWsServerFrame;
}

function childEvent(seq: number, text: string): MobileWsServerFrame {
  return {
    type: 'event',
    id: 'child-turn-1',
    conversationId: 'sub_a',
    seq,
    event: { type: 'text_delta', text },
  } as MobileWsServerFrame;
}

function childDone(seq = 43): MobileWsServerFrame {
  return {
    type: 'done',
    id: 'child-turn-1',
    conversationId: 'sub_a',
    seq,
    outcome: 'completed',
  } as MobileWsServerFrame;
}

/**
 * A child's transient progress, on the PARENT's stream. `subagent_progress`
 * is never logged (design §7.2), so it only exists while a parent turn is
 * live — which is the window `parked` was getting wrong.
 */
function parentProgress(status: 'running' | 'waiting_input', seq = 1): MobileWsServerFrame {
  return {
    type: 'event',
    id: 'parent-turn-1',
    conversationId: parentRef.id,
    seq,
    event: {
      type: 'subagent_progress',
      subagentId: 'sub_a',
      status,
      toolCallCount: 2,
      elapsedMs: 1000,
      ...(status === 'waiting_input' ? { question: 'which branch?' } : {}),
    },
  } as MobileWsServerFrame;
}

function parentWorkerStatus(status: 'running' | 'waiting_input', seq = 1): MobileWsServerFrame {
  return {
    type: 'event',
    id: 'parent-turn-1',
    conversationId: parentRef.id,
    seq,
    event: {
      type: 'worker_status',
      workerId: 'sub_a',
      runId: 'run-1',
      role: 'code-reviewer',
      status,
    },
  } as MobileWsServerFrame;
}

function parentFinished(seq = 1): MobileWsServerFrame {
  return {
    type: 'event',
    id: 'parent-turn-1',
    conversationId: parentRef.id,
    seq,
    event: {
      type: 'subagent_finished',
      subagentId: 'sub_a',
      subagentType: 'code-reviewer',
      description: 'Review the diff',
      status: 'done',
      report: 'all good',
      toolCallCount: 2,
      startedAt: '2026-07-12T00:00:00.000Z',
      endedAt: '2026-07-12T00:01:00.000Z',
    },
  } as MobileWsServerFrame;
}

function childMessage(id: string, over: Partial<ConversationMessage> = {}): ConversationMessage {
  return { ...message(id, childRef, 'assistant'), ordinal: 1, ...over };
}

/**
 * Subscription bookkeeping is CLOSURE state in the store — it is wiring, and
 * nothing renders it — so the global `beforeEach`'s `setState` does not touch
 * it, exactly as a re-render does not touch it in the app. A conversation
 * switch is what clears it there, and here.
 */
async function releaseEverySubscription(): Promise<void> {
  mockApi.chatGetConversation.mockResolvedValue({ ...gatewayConversation, id: 'reset' });
  mockApi.chatGetMessages.mockResolvedValue({ items: [], nextCursor: null, throughSeq: 0 });
  await useChatStore.getState().selectConversation({ id: 'reset', origin: 'gateway' });
  mockApi.chatGetConversation.mockReset();
  mockApi.chatGetMessages.mockReset();
  mockApi.subagentsList.mockClear();
  mockApi.subagentSubscribe.mockClear();
  mockApi.subagentUnsubscribe.mockClear();
  mockApi.conversationMessages.mockClear();
}

describe('sub-agent subscriptions', () => {
  beforeEach(releaseEverySubscription);

  it('watches a child once however many cards hold it, and releases after the last', async () => {
    await selectParentWithAgent();

    useChatStore.getState().subscribeSubagent('sub_a');
    useChatStore.getState().subscribeSubagent('sub_a');

    expect(mockApi.subagentSubscribe).toHaveBeenCalledExactlyOnceWith('agent-1', 'sub_a');

    useChatStore.getState().unsubscribeSubagent('sub_a');
    await Promise.resolve();
    expect(mockApi.subagentUnsubscribe).not.toHaveBeenCalled();

    useChatStore.getState().unsubscribeSubagent('sub_a');
    await Promise.resolve();
    expect(mockApi.subagentUnsubscribe).toHaveBeenCalledExactlyOnceWith('sub_a');
  });

  // A card is remounted by things that have nothing to do with it — the
  // streaming bubble and the finalized bubble are different elements, and
  // React runs the removed subtree's cleanup before the added subtree's setup
  // inside ONE commit. A synchronous release would put a real `unsubscribe` on
  // the wire, and the gateway replays nothing on the `subscribe` that follows.
  it('sends no unsubscribe when a card remounts in one commit', async () => {
    await selectParentWithAgent();
    useChatStore.getState().subscribeSubagent('sub_a');
    mockApi.subagentSubscribe.mockClear();

    useChatStore.getState().unsubscribeSubagent('sub_a');
    useChatStore.getState().subscribeSubagent('sub_a');
    await Promise.resolve();

    expect(mockApi.subagentUnsubscribe).not.toHaveBeenCalled();
    expect(mockApi.subagentSubscribe).not.toHaveBeenCalled();
    expect(useChatStore.getState().isSubagentSubscribed('sub_a')).toBe(true);
  });

  it('takes no hold it could not address, so no release can unbalance the count', async () => {
    useChatStore.setState({
      selectedConversationRef: { id: 'legacy-1', origin: 'local' },
      conversations: [localConversation],
    });

    useChatStore.getState().subscribeSubagent('sub_a');

    expect(mockApi.subagentSubscribe).not.toHaveBeenCalled();
    expect(useChatStore.getState().isSubagentSubscribed('sub_a')).toBe(false);
  });

  it('releases every hold on the way out of a conversation, and only once', async () => {
    await selectParentWithAgent();
    useChatStore.getState().subscribeSubagent('sub_a');
    useChatStore.getState().subscribeSubagent('sub_b');

    mockApi.chatGetConversation.mockResolvedValue({ ...gatewayConversation, id: 'other' });
    mockApi.chatGetMessages.mockResolvedValue({ items: [], nextCursor: null, throughSeq: 0 });
    await useChatStore.getState().selectConversation({ id: 'other', origin: 'gateway' });

    expect(mockApi.subagentUnsubscribe.mock.calls).toEqual([['sub_a'], ['sub_b']]);
    // The cards unmount AFTER the switch and release again.
    useChatStore.getState().unsubscribeSubagent('sub_a');
    await Promise.resolve();
    expect(mockApi.subagentUnsubscribe).toHaveBeenCalledTimes(2);
  });

  // F2. The shape the rulings themselves create: the panel holds every
  // non-terminal child while it is open (`SwarmPanel.tsx:77-84`) and the card
  // holds its own while expanded (`routes/chat.tsx:1024-1028`), so `holds` is
  // 2. Mid-stream the socket dies — 4429, a 4401 on token expiry, an older
  // gateway's `validation_failed` — and `live` goes false.
  //
  // Collapsing the card takes 2 → 1, which is not a genuine release, so no
  // `transcriptLoaded: false` fires. Re-expanding takes 1 → 2 and used to
  // return on the existing entry BEFORE any IPC, so main was never re-entered:
  // no re-subscribe, no re-read, optimism off, and no re-read owed. The card
  // sat at the partial sentence until the user closed the panel AND collapsed
  // the card, which is not something the card can tell them to do.
  //
  // Re-taking a DEAD hold now asks for a fresh socket. It takes no hold and
  // releases none, so main's count is exactly what it was and the 1:1 pairing
  // the refcount depends on is untouched.
  it('asks for a fresh socket when a hold is re-taken while the watch is dead', async () => {
    await selectParentWithAgent();
    // The panel's hold, then the card's.
    useChatStore.getState().subscribeSubagent('sub_a');
    useChatStore.getState().subscribeSubagent('sub_a');
    useChatStore.getState().markSubagentWatchLost('sub_a');
    mockApi.subagentSubscribe.mockClear();

    // Collapse: 2 → 1, and the panel still holds, so nothing is released.
    useChatStore.getState().unsubscribeSubagent('sub_a');
    await Promise.resolve();
    expect(mockApi.subagentUnsubscribe).not.toHaveBeenCalled();

    // Re-expand: 1 → 2, on a watch that is not open.
    useChatStore.getState().subscribeSubagent('sub_a');

    expect(mockApi.subagentRewatch).toHaveBeenCalledExactlyOnceWith('agent-1', 'sub_a');
    // Not a second subscribe, and not a release: the count never moved.
    expect(mockApi.subagentSubscribe).not.toHaveBeenCalled();
    expect(mockApi.subagentUnsubscribe).not.toHaveBeenCalled();
  });

  // The other half: a hold re-taken on a watch that is ALIVE asks for nothing.
  // A card remounting mid-stream is the common case, and a rewatch there would
  // put a `subscribe` on the wire for a socket that is already open.
  it('asks for nothing when a hold is re-taken on a live watch', async () => {
    await selectParentWithAgent();
    useChatStore.getState().subscribeSubagent('sub_a');

    useChatStore.getState().subscribeSubagent('sub_a');

    expect(mockApi.subagentRewatch).not.toHaveBeenCalled();
  });

  // What the re-watch buys, end to end at the store: main answers the fresh
  // socket's open with `chat:subagentResubscribed`, which is the ONLY thing
  // that puts optimism back and forces the re-read the card has been owed
  // since the stream died. Both holders are still counted throughout.
  it('recovers the card once the fresh socket opens', async () => {
    await selectParentWithAgent();
    useChatStore.getState().subscribeSubagent('sub_a');
    useChatStore.getState().subscribeSubagent('sub_a');
    await useChatStore.getState().loadSubagentTranscript('sub_a');
    useChatStore.getState().markSubagentWatchLost('sub_a');
    expect(useChatStore.getState().isSubagentSubscribed('sub_a')).toBe(false);
    useChatStore.getState().unsubscribeSubagent('sub_a');
    await Promise.resolve();
    useChatStore.getState().subscribeSubagent('sub_a');
    expect(mockApi.subagentRewatch).toHaveBeenCalledExactlyOnceWith('agent-1', 'sub_a');
    mockApi.conversationMessages.mockClear();

    await useChatStore.getState().restoreSubagentTranscript('sub_a');

    expect(useChatStore.getState().isSubagentSubscribed('sub_a')).toBe(true);
    expect(mockApi.conversationMessages).toHaveBeenCalledWith('sub_a');
  });
});

describe('sub-agent live transcripts', () => {
  beforeEach(releaseEverySubscription);

  it("routes a child's frames into its card and never into a conversation transcript", async () => {
    await selectParentWithAgent();
    useChatStore.getState().subscribeSubagent('sub_a');

    await useChatStore.getState().applyFrame(accepted());
    await useChatStore.getState().applyFrame(childEvent(42, 'thinking'));

    const transcript = useChatStore.getState().subagentUi.sub_a.transcript;
    expect(transcript).toHaveLength(1);
    expect(transcript?.[0]).toMatchObject({
      id: 'child-assistant-1',
      turnId: 'child-turn-1',
      role: 'assistant',
      status: 'streaming',
      content: { type: 'assistant', events: [{ type: 'text_delta', text: 'thinking' }] },
    });
    // Not the parent's, and not a transcript of its own either: `applyFrame`
    // keys `messages`/`streamingFrames` by `frame.conversationId`, so an
    // unrouted child frame would land under `gateway:sub_a` and its `done`
    // would then take `refreshTerminal` down `chatGetMessages`, which
    // subscribes the resumable transport to a SECOND socket on the same child.
    expect(useChatStore.getState().messages['gateway:sub_a']).toBeUndefined();
    expect(useChatStore.getState().streamingFrames['gateway:sub_a']).toBeUndefined();
    expect(useChatStore.getState().messages['gateway:shared-id']).toBeUndefined();
    expect(mockApi.chatGetMessages).not.toHaveBeenCalled();
  });

  it('keeps routing a released child until the conversation itself changes', async () => {
    await selectParentWithAgent();
    useChatStore.getState().subscribeSubagent('sub_a');
    useChatStore.getState().unsubscribeSubagent('sub_a');
    await Promise.resolve();

    // The `unsubscribe` is on the wire; main has not closed the socket yet.
    await useChatStore.getState().applyFrame(accepted());

    expect(useChatStore.getState().subagentUi.sub_a?.transcript).toHaveLength(1);
    expect(useChatStore.getState().streamingFrames['gateway:sub_a']).toBeUndefined();
  });

  it('finalizes the live row on done and re-reads the child it belongs to', async () => {
    await selectParentWithAgent();
    mockApi.conversationMessages.mockResolvedValue({
      items: [],
      nextCursor: null,
      throughSeq: 0,
    });
    useChatStore.getState().subscribeSubagent('sub_a');
    await useChatStore.getState().loadSubagentTranscript('sub_a');
    await useChatStore.getState().applyFrame(accepted());
    await useChatStore.getState().applyFrame(childEvent(42, 'done thinking'));
    mockApi.conversationMessages.mockClear();
    mockApi.subagentsList.mockClear();

    await useChatStore.getState().applyFrame(childDone());
    await vi.waitFor(() => expect(mockApi.conversationMessages).toHaveBeenCalledWith('sub_a'));

    expect(mockApi.subagentsList).toHaveBeenCalled();
  });

  // Web D2 round 4, guard 1: `done` may arrive after a REST read has already
  // landed the finished row — the collapse window, or a reconnect — and
  // rewriting it there costs content this stream never carried. It also must
  // reach only the turn it names: a child can have a second turn in flight.
  it('leaves a finished row alone when a done arrives over it', async () => {
    await selectParentWithAgent();
    const finished = childMessage('child-assistant-1', {
      turnId: 'child-turn-1',
      status: 'completed',
      content: { type: 'assistant', events: [{ type: 'text_delta', text: 'the whole report' }] },
    });
    mockApi.conversationMessages.mockResolvedValue({
      items: [finished],
      nextCursor: null,
      throughSeq: 0,
    });
    useChatStore.getState().subscribeSubagent('sub_a');
    await useChatStore.getState().loadSubagentTranscript('sub_a');
    await useChatStore
      .getState()
      .applyFrame(
        accepted({ id: 'child-turn-2', seq: 50, assistantMessageId: 'child-assistant-2' }),
      );

    await useChatStore.getState().applyFrame(childDone());

    const transcript = useChatStore.getState().subagentUi.sub_a.transcript;
    expect(transcript?.[0]).toEqual(finished);
    // The second turn is still running; a `done` for the first must not end it.
    expect(transcript?.[1]).toMatchObject({ turnId: 'child-turn-2', status: 'streaming' });
  });

  // `done` carries the outcome, and a cancelled turn is not a completed one.
  it('finalizes a cancelled turn as cancelled', async () => {
    await selectParentWithAgent();
    useChatStore.getState().subscribeSubagent('sub_a');
    await useChatStore.getState().applyFrame(accepted());

    await useChatStore
      .getState()
      .applyFrame({ ...childDone(), outcome: 'cancelled' } as MobileWsServerFrame);

    expect(useChatStore.getState().subagentUi.sub_a.transcript?.[0]).toMatchObject({
      status: 'cancelled',
    });
  });

  it('keeps a live row through a re-read the server has not caught up with', async () => {
    await selectParentWithAgent();
    mockApi.conversationMessages.mockResolvedValue({
      items: [childMessage('older', { turnId: 'child-turn-0', ordinal: 1 })],
      nextCursor: null,
      throughSeq: 0,
    });
    useChatStore.getState().subscribeSubagent('sub_a');
    await useChatStore.getState().loadSubagentTranscript('sub_a');
    await useChatStore.getState().applyFrame(accepted());
    await useChatStore.getState().applyFrame(childEvent(42, 'half a sentence'));

    await useChatStore.getState().loadSubagentTranscript('sub_a', true);

    const transcript = useChatStore.getState().subagentUi.sub_a.transcript;
    expect(transcript?.map((m) => m.id)).toEqual(['older', 'child-assistant-1']);
    expect(transcript?.[1]).toMatchObject({
      status: 'streaming',
      content: { type: 'assistant', events: [{ type: 'text_delta', text: 'half a sentence' }] },
    });
  });

  // The CONTROL for the test below, and the other direction of ruling 3's
  // guard 1: the server has this row and still says it is `streaming`, so its
  // copy is a snapshot taken before the events this store is holding. Both
  // sides agree the turn is live, and the local fragment wins. Keep the pair
  // together — on its own this one pins nothing about what happens when the
  // server has FINISHED, which is the case the round originally missed.
  it('keeps a live row the server has an emptier copy of', async () => {
    await selectParentWithAgent();
    mockApi.conversationMessages.mockResolvedValue({
      items: [],
      nextCursor: null,
      throughSeq: 0,
    });
    useChatStore.getState().subscribeSubagent('sub_a');
    await useChatStore.getState().loadSubagentTranscript('sub_a');
    await useChatStore.getState().applyFrame(accepted());
    await useChatStore.getState().applyFrame(childEvent(42, 'the part only the stream has'));
    mockApi.conversationMessages.mockResolvedValue({
      items: [
        childMessage('child-assistant-1', {
          turnId: 'child-turn-1',
          status: 'streaming',
          content: { type: 'assistant', events: [] },
        }),
      ],
      nextCursor: null,
      throughSeq: 0,
    });

    await useChatStore.getState().loadSubagentTranscript('sub_a', true);

    const transcript = useChatStore.getState().subagentUi.sub_a.transcript;
    expect(transcript).toHaveLength(1);
    expect(transcript?.[0]).toMatchObject({
      status: 'streaming',
      content: {
        type: 'assistant',
        events: [{ type: 'text_delta', text: 'the part only the stream has' }],
      },
    });
  });

  // The OTHER direction, and the half ruling 3 calls guard 1: the server says
  // that turn is OVER. Its copy is then the complete one and the local
  // fragment is what the reconnect gap left behind — the `done` never arrived
  // and never will, so keeping the fragment strands the card mid-sentence
  // under a header that reads `Done` for the rest of the selection.
  it("takes the server's finished copy when the done fell in a reconnect gap", async () => {
    await selectParentWithAgent();
    mockApi.conversationMessages.mockResolvedValue({
      items: [],
      nextCursor: null,
      throughSeq: 0,
    });
    useChatStore.getState().subscribeSubagent('sub_a');
    await useChatStore.getState().loadSubagentTranscript('sub_a');
    await useChatStore.getState().applyFrame(accepted());
    await useChatStore.getState().applyFrame(childEvent(42, 'half a '));
    // The socket dropped here. The rest of the reply AND the `done` fell in the
    // gap; the server has the whole turn.
    mockApi.conversationMessages.mockResolvedValue({
      items: [
        childMessage('child-assistant-1', {
          turnId: 'child-turn-1',
          status: 'completed',
          content: { type: 'assistant', events: [{ type: 'text_delta', text: 'half a sentence' }] },
        }),
      ],
      nextCursor: null,
      throughSeq: 0,
    });

    await useChatStore.getState().restoreSubagentTranscript('sub_a');

    const transcript = useChatStore.getState().subagentUi.sub_a.transcript;
    expect(transcript).toHaveLength(1);
    expect(transcript?.[0]).toMatchObject({
      id: 'child-assistant-1',
      status: 'completed',
      content: { type: 'assistant', events: [{ type: 'text_delta', text: 'half a sentence' }] },
    });
  });

  // I3. A VOLUNTARY release — collapsing the card, or the panel closing — is
  // exactly the moment this client stops being able to see the child's
  // `done`, and it triggers none of ruling 3's three recoveries. Without this
  // the next expansion early-returns on `transcriptLoaded` and the body sits
  // at the partial sentence with a streaming indicator, under a header that
  // reads `Done` from REST, until the conversation selection changes.
  it('owes the card a re-read once its hold is released', async () => {
    await selectParentWithAgent();
    mockApi.conversationMessages.mockResolvedValue({
      items: [],
      nextCursor: null,
      throughSeq: 0,
    });
    useChatStore.getState().subscribeSubagent('sub_a');
    await useChatStore.getState().loadSubagentTranscript('sub_a');
    await useChatStore.getState().applyFrame(accepted());
    expect(useChatStore.getState().subagentUi.sub_a.transcriptLoaded).toBe(true);

    useChatStore.getState().unsubscribeSubagent('sub_a');
    await vi.waitFor(() => expect(mockApi.subagentUnsubscribe).toHaveBeenCalledWith('sub_a'));
    mockApi.conversationMessages.mockClear();
    // The card is re-expanded. Its effect asks WITHOUT `force`, which is the
    // whole problem: only the loaded flag decides.
    await useChatStore.getState().loadSubagentTranscript('sub_a');

    expect(mockApi.conversationMessages).toHaveBeenCalledExactlyOnceWith('sub_a');
    // The rows the stream built stay on screen until the re-read lands —
    // dropping the flag owes a read, it does not blank the card.
    expect(useChatStore.getState().subagentUi.sub_a.transcript).toHaveLength(1);
  });

  it('re-reads a restored child, and the live row survives it', async () => {
    await selectParentWithAgent();
    mockApi.conversationMessages.mockResolvedValue({
      items: [],
      nextCursor: null,
      throughSeq: 0,
    });
    useChatStore.getState().subscribeSubagent('sub_a');
    await useChatStore.getState().loadSubagentTranscript('sub_a');
    await useChatStore.getState().applyFrame(accepted());
    mockApi.conversationMessages.mockClear();

    await useChatStore.getState().restoreSubagentTranscript('sub_a');

    expect(mockApi.conversationMessages).toHaveBeenCalledWith('sub_a');
    expect(useChatStore.getState().subagentUi.sub_a.transcript?.map((m) => m.id)).toEqual([
      'child-assistant-1',
    ]);
  });

  // A restore is the one moment we KNOW a `done` may have fallen in a gap. A
  // child held only by the open panel has no transcript to re-read, but it
  // does have a row that would otherwise read `Running` until the 20 s
  // backstop came round.
  it('re-reads the list on a restore even with no transcript to re-read', async () => {
    await selectParentWithAgent();
    useChatStore.getState().subscribeSubagent('sub_a');

    await useChatStore.getState().restoreSubagentTranscript('sub_a');

    expect(mockApi.conversationMessages).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(mockApi.subagentsList).toHaveBeenCalledWith('shared-id'));
  });
});

// I1's second half. Closing the macOS window and clicking the dock icon
// builds a FRESH renderer with an empty `knownChildIds`, and until it selects
// a conversation it knows nothing. A child frame still in flight then falls
// to the conversation path, is keyed under the child's own id with `lastSeq`
// 0, gaps on its mid-turn seq, and `refreshTerminal` sends `chatGetMessages`
// — which subscribes the resumable transport to the running turn
// (`chat-service.ts`'s `getMessages`). A SECOND, turn-scoped socket on a
// conversation this client already watches: the exact stampede ruling 4's
// routing branch exists to make impossible, through the one door it does not
// cover.
describe('frames for a conversation this renderer has no record of', () => {
  beforeEach(releaseEverySubscription);

  it('opens no recovery read for a conversation it has never heard of', async () => {
    useChatStore.setState({ selectedConversationRef: null, conversations: [] });

    await useChatStore.getState().applyFrame(childEvent(42, 'mid-turn, from before the reload'));
    await useChatStore.getState().applyFrame(childDone(43));

    expect(mockApi.chatGetMessages).not.toHaveBeenCalled();
  });

  // The control, so the guard is not "never recover": a conversation the
  // renderer HAS still heals its own gap.
  it('still recovers a gap on a conversation it knows', async () => {
    useChatStore.setState({
      selectedConversationRef: null,
      conversations: [{ ...gatewayConversation, id: 'sub_a' }],
    });
    mockApi.chatGetConversation.mockResolvedValue({ ...gatewayConversation, id: 'sub_a' });
    mockApi.chatGetMessages.mockResolvedValue({ items: [], nextCursor: null, throughSeq: 0 });

    await useChatStore.getState().applyFrame(childEvent(42, 'mid-turn'));

    expect(mockApi.chatGetMessages).toHaveBeenCalledOnce();
  });

  // The THIRD removal path, and the one the guard was written without.
  // `reconcileFirstPage` does not merge: it returns `incoming.map(...)` and
  // drops every conversation absent from the new first page. A conversation
  // that reached `conversations` by `ensureConversation`'s upsert rather than
  // by page 1 — a project session's, `routes/projects/issues.$issueId.tsx` —
  // is evicted by any `loadConversations()` whose page does not carry it, and
  // `loadConversations()` runs from three places that have nothing to do with
  // that session. Mid-turn, the eviction used to strip it of its terminal
  // recovery: `sending` stayed `true` for the rest of the session and
  // `SessionPanel.composerLocked` includes `sending`.
  //
  // What this renderer has READ is the property the guard actually wanted.
  it('still recovers a mid-turn conversation the first page has evicted', async () => {
    const session: McConversationView = { ...gatewayConversation, id: 'session-1' };
    const ref = { id: 'session-1', origin: 'gateway' as const };
    const key = conversationKey(ref);
    useChatStore.setState({
      selectedConversationRef: null,
      conversations: [session],
      // What `SessionPanel`'s `ensureMessages` leaves behind on mount.
      messages: { [key]: [] },
      sending: { [key]: true },
      lastSeq: { [key]: 40 },
    });
    mockApi.chatListConversations.mockResolvedValue({
      items: [gatewayConversation],
      nextCursor: null,
      authority: 'gateway',
      gatewayOnline: true,
    });

    await useChatStore.getState().loadConversations();

    // The eviction itself, so this test fails for the right reason if
    // `reconcileFirstPage` ever starts merging.
    expect(useChatStore.getState().conversations.map((item) => item.id)).not.toContain('session-1');

    mockApi.chatGetConversation.mockResolvedValue(session);
    mockApi.chatGetMessages.mockResolvedValue({ items: [], nextCursor: null, throughSeq: 43 });

    await useChatStore.getState().applyFrame({
      type: 'done',
      id: 'session-turn-1',
      conversationId: 'session-1',
      seq: 43,
      outcome: 'completed',
    } as MobileWsServerFrame);

    expect(mockApi.chatGetMessages).toHaveBeenCalledWith(ref, undefined);
    expect(useChatStore.getState().sending[key]).toBe(false);
  });
});

describe('sub-agent optimistic rows', () => {
  beforeEach(releaseEverySubscription);

  it("shows the user's sentence while a subscription is held, and pairs it by requestId", async () => {
    await selectParentWithAgent();
    mockApi.subagentsList.mockResolvedValue([subagentEntry()]);
    mockApi.conversationMessages.mockResolvedValue({
      items: [],
      nextCursor: null,
      throughSeq: 0,
    });
    useChatStore.getState().subscribeSubagent('sub_a');
    await useChatStore.getState().refreshSubagents();

    await useChatStore.getState().resumeSubagent('sub_a', 'try the other branch');

    const requestId = mockApi.subagentResume.mock.calls[0][2] as string;
    const rows = useChatStore.getState().subagentUi.sub_a.transcript;
    const optimistic = rows?.find((m) => m.role === 'user');
    expect(optimistic).toMatchObject({
      role: 'user',
      turnId: requestId,
      content: { type: 'user', text: 'try the other branch' },
    });

    await useChatStore.getState().applyFrame(accepted({ requestId }));

    const paired = useChatStore
      .getState()
      .subagentUi.sub_a.transcript?.find((m) => m.role === 'user');
    // The server's own id, so the next REST page supersedes this row instead
    // of landing beside it.
    expect(paired).toMatchObject({ id: 'child-user-1', turnId: 'child-turn-1' });
  });

  it('drops the paired row once the server has its own copy', async () => {
    await selectParentWithAgent();
    mockApi.subagentsList.mockResolvedValue([subagentEntry()]);
    useChatStore.getState().subscribeSubagent('sub_a');
    await useChatStore.getState().refreshSubagents();
    await useChatStore.getState().resumeSubagent('sub_a', 'try the other branch');
    const requestId = mockApi.subagentResume.mock.calls[0][2] as string;
    await useChatStore.getState().applyFrame(accepted({ requestId }));
    await useChatStore.getState().applyFrame(childDone());
    mockApi.conversationMessages.mockResolvedValue({
      items: [
        {
          ...message('child-user-1', childRef, 'user'),
          turnId: 'child-turn-1',
          ordinal: 1,
          content: { type: 'user', text: 'try the other branch' },
        },
      ],
      nextCursor: null,
      throughSeq: 0,
    });

    await useChatStore.getState().loadSubagentTranscript('sub_a', true);

    const rows = useChatStore.getState().subagentUi.sub_a.transcript ?? [];
    expect(rows.filter((row) => row.role === 'user')).toHaveLength(1);
  });

  /**
   * T3/S4, the analogue of web's two crafted-`requestId` cases
   * (`apps/web/src/state/store.test.ts`). `requestId` is a value the CLIENT
   * chose, and the `accepted` echoing it reaches every sink subscribed to this
   * child — so a co-authorised peer can `POST /subagents/:id/resume` with a
   * genuine server `turnId` and the gateway will echo it verbatim. Matching on
   * `turnId === requestId` therefore selected a row this client never minted.
   */
  it('never relabels a SERVER row named by a crafted requestId', async () => {
    await selectParentWithAgent();
    mockApi.subagentsList.mockResolvedValue([subagentEntry()]);
    mockApi.conversationMessages.mockResolvedValue({
      items: [
        {
          ...message('server-user-1', childRef, 'user'),
          turnId: 'server-turn-0',
          ordinal: 1,
          content: { type: 'user', text: 'the sentence a peer wants moved' },
        },
        {
          ...message('server-user-9', childRef, 'user'),
          turnId: 'server-turn-9',
          ordinal: 2,
          content: { type: 'user', text: 'the turn actually being accepted' },
        },
      ],
      nextCursor: null,
      throughSeq: 0,
    });
    useChatStore.getState().subscribeSubagent('sub_a');
    await useChatStore.getState().refreshSubagents();
    await useChatStore.getState().loadSubagentTranscript('sub_a', true);

    // Both ids belong to the server. `requestId` names the victim's turn.
    await useChatStore.getState().applyFrame(
      accepted({
        id: 'server-turn-9',
        userMessageId: 'server-user-9',
        requestId: 'server-turn-0',
      }),
    );

    const users = (useChatStore.getState().subagentUi.sub_a.transcript ?? []).filter(
      (row) => row.role === 'user',
    );
    expect(users.map((row) => row.id)).toEqual(['server-user-1', 'server-user-9']);
    expect(users[0]).toMatchObject({ turnId: 'server-turn-0' });
    expect(users[0].content).toMatchObject({ text: 'the sentence a peer wants moved' });
  });

  /**
   * The other half, with no companion row: the victim is the only user row, so
   * nothing else could be mistaken for it. Without the id-shape check the
   * crafted `requestId` displaces it onto the new turn's ids and the user's
   * sentence is re-attributed in every MC window watching this child.
   */
  it('never adopts a SERVER row named by a crafted requestId, even as the only user row', async () => {
    await selectParentWithAgent();
    mockApi.subagentsList.mockResolvedValue([subagentEntry()]);
    mockApi.conversationMessages.mockResolvedValue({
      items: [
        {
          ...message('server-user-1', childRef, 'user'),
          turnId: 'server-turn-0',
          ordinal: 1,
          content: { type: 'user', text: 'the only sentence there is' },
        },
      ],
      nextCursor: null,
      throughSeq: 0,
    });
    useChatStore.getState().subscribeSubagent('sub_a');
    await useChatStore.getState().refreshSubagents();
    await useChatStore.getState().loadSubagentTranscript('sub_a', true);

    await useChatStore.getState().applyFrame(
      accepted({
        id: 'server-turn-9',
        userMessageId: 'server-user-9',
        requestId: 'server-turn-0',
      }),
    );

    const users = (useChatStore.getState().subagentUi.sub_a.transcript ?? []).filter(
      (row) => row.role === 'user',
    );
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ id: 'server-user-1', turnId: 'server-turn-0' });
  });

  it('adds no row when nothing holds a subscription, because no accepted will arrive', async () => {
    await selectParentWithAgent();
    mockApi.subagentsList.mockResolvedValue([subagentEntry()]);
    await useChatStore.getState().refreshSubagents();

    await useChatStore.getState().resumeSubagent('sub_a', 'try the other branch');

    expect(useChatStore.getState().subagentUi.sub_a.transcript).toBeUndefined();
  });

  // `sendToChild`'s answering branch resolves the child's pending question
  // (`packages/swarm/src/child-handle.ts:386-397`): no new turn, no `accepted`,
  // and no user row persisted either. An optimistic row there is a sentence the
  // child's transcript will never contain, and nothing would ever supersede it.
  it('adds no row for an answer to a parked child', async () => {
    await selectParentWithAgent();
    mockApi.subagentsList.mockResolvedValue([subagentEntry({ status: 'waiting_input' })]);
    useChatStore.getState().subscribeSubagent('sub_a');
    await useChatStore.getState().refreshSubagents();

    await useChatStore.getState().resumeSubagent('sub_a', 'the second one');

    expect(useChatStore.getState().subagentUi.sub_a.transcript).toBeUndefined();
  });

  // C2. A hold is bookkeeping; only an OPEN SOCKET can carry an `accepted`.
  // Four paths leave the first without the second — the factory throwing, an
  // auth close, an older gateway refusing `subscribe`, and a hold taken with
  // no transport — and a fifth, an ordinary reconnect, leaves it briefly.
  // Optimism in any of them writes a `pending:<uuid>` row keyed on a
  // `requestId` nothing will ever echo, and the merge keeps it forever: its
  // id is never in a page's ids and its turn is never in a page's turns. The
  // user's own sentence, twice, permanently.
  it('adds no second copy of the sentence when the hold is dead', async () => {
    await selectParentWithAgent();
    mockApi.subagentsList.mockResolvedValue([subagentEntry()]);
    useChatStore.getState().subscribeSubagent('sub_a');
    await useChatStore.getState().refreshSubagents();
    // Main says the socket behind this hold is not open.
    useChatStore.getState().markSubagentWatchLost('sub_a');

    await useChatStore.getState().resumeSubagent('sub_a', 'try the other branch');

    // No `accepted` frame is delivered: that is the whole point of the case.
    mockApi.conversationMessages.mockResolvedValue({
      items: [
        {
          ...message('server-user-1', childRef, 'user'),
          turnId: 'server-turn-1',
          ordinal: 1,
          content: { type: 'user', text: 'try the other branch' },
        },
      ],
      nextCursor: null,
      throughSeq: 0,
    });
    await useChatStore.getState().loadSubagentTranscript('sub_a', true);

    const rows = useChatStore.getState().subagentUi.sub_a.transcript ?? [];
    expect(rows.filter((row) => row.role === 'user')).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'server-user-1' });
  });

  // The other direction, so the fix is not "never show the row": a lost watch
  // that comes back is a live stream again, and `chat:subagentResubscribed`
  // is the only thing that says so.
  it('shows the row again once the watch is restored', async () => {
    await selectParentWithAgent();
    mockApi.subagentsList.mockResolvedValue([subagentEntry()]);
    mockApi.conversationMessages.mockResolvedValue({
      items: [],
      nextCursor: null,
      throughSeq: 0,
    });
    useChatStore.getState().subscribeSubagent('sub_a');
    await useChatStore.getState().refreshSubagents();
    useChatStore.getState().markSubagentWatchLost('sub_a');
    await useChatStore.getState().restoreSubagentTranscript('sub_a');

    await useChatStore.getState().resumeSubagent('sub_a', 'try the other branch');

    const rows = useChatStore.getState().subagentUi.sub_a.transcript ?? [];
    expect(rows.filter((row) => row.role === 'user')).toHaveLength(1);
  });

  // I2. `parked` was decided from REST alone, which lags the gateway by up to
  // 20 s — and that is exactly the window in which a user answers. A
  // `subagent_progress { status: 'waiting_input' }` reaches this client's
  // `applyFrame` the moment the child parks, and D7b threw it away because
  // `subagent_progress` is deliberately not a list trigger. The panel's
  // Resume box then opened for a child REST still called `running`, the
  // gateway took `sendToChild`'s ANSWERING branch — which starts no turn,
  // emits no `accepted` and persists no user row — and the optimistic row
  // stranded forever.
  //
  // The store does the reading, not the panel, so D7's "the panel is
  // REST-only" ruling is untouched and `subagent_progress` is still not a
  // list trigger.
  it('adds no row for an answer the live stream knows is an answer', async () => {
    await selectParentWithAgent();
    // REST still says `running`: this is the lag, not a fixture convenience.
    mockApi.subagentsList.mockResolvedValue([subagentEntry({ status: 'running' })]);
    useChatStore.getState().subscribeSubagent('sub_a');
    await useChatStore.getState().refreshSubagents();
    await useChatStore.getState().applyFrame(parentProgress('waiting_input'));

    await useChatStore.getState().resumeSubagent('sub_a', 'the second one');

    expect(useChatStore.getState().subagentUi.sub_a.transcript).toBeUndefined();
  });

  // The control, and it also proves the map is not sticky: a child that parks
  // and then runs again is steerable, and a steer IS shown.
  it('shows the row again once the live stream says the child is running', async () => {
    await selectParentWithAgent();
    mockApi.subagentsList.mockResolvedValue([subagentEntry({ status: 'running' })]);
    useChatStore.getState().subscribeSubagent('sub_a');
    await useChatStore.getState().refreshSubagents();
    await useChatStore.getState().applyFrame(parentProgress('waiting_input', 1));
    await useChatStore.getState().applyFrame(parentProgress('running', 2));

    await useChatStore.getState().resumeSubagent('sub_a', 'keep going');

    expect(useChatStore.getState().subagentUi.sub_a.transcript).toHaveLength(1);
  });

  // D8 retired the `worker_status` mirror: a persisted pre-D8 one reaching the
  // store must park NOTHING. The canonical `subagent_progress` above is the
  // only source of a parked child now.
  it('ignores a retired worker_status mirror', async () => {
    await selectParentWithAgent();
    mockApi.subagentsList.mockResolvedValue([subagentEntry({ status: 'running' })]);
    useChatStore.getState().subscribeSubagent('sub_a');
    await useChatStore.getState().refreshSubagents();
    await useChatStore.getState().applyFrame(parentWorkerStatus('waiting_input'));

    await useChatStore.getState().resumeSubagent('sub_a', 'the second one');

    // Nothing parked the child, so this reads as a STEER and the optimistic
    // row is shown — the same answer the store gives for a child that never
    // parked at all. Pre-D8 the mirror parked it and the row was suppressed.
    expect(useChatStore.getState().subagentUi.sub_a.transcript).toHaveLength(1);
  });

  // A finished child cannot be parked, and the entry must not outlive it: a
  // resume that restarts it would otherwise read `waiting` for the whole new
  // run. Same reason D3 refused to merge the REST list with the fold.
  it('forgets a parked child once its finish reaches the parent stream', async () => {
    await selectParentWithAgent();
    mockApi.subagentsList.mockResolvedValue([subagentEntry({ status: 'running' })]);
    useChatStore.getState().subscribeSubagent('sub_a');
    await useChatStore.getState().refreshSubagents();
    await useChatStore.getState().applyFrame(parentProgress('waiting_input', 1));
    await useChatStore.getState().applyFrame(parentFinished(2));

    await useChatStore.getState().resumeSubagent('sub_a', 'run again');

    expect(useChatStore.getState().subagentUi.sub_a.transcript).toHaveLength(1);
  });

  // Everything keyed by child id describes ONE conversation. Without this the
  // map would outlive the switch and grow for the store's lifetime — the
  // defect D2 and D3 already paid for with `subagentInfo` and `transcripts`.
  it('forgets what the live stream said when the conversation changes', async () => {
    await selectParentWithAgent();
    mockApi.subagentsList.mockResolvedValue([subagentEntry({ status: 'running' })]);
    useChatStore.getState().subscribeSubagent('sub_a');
    await useChatStore.getState().refreshSubagents();
    await useChatStore.getState().applyFrame(parentProgress('waiting_input'));

    await releaseEverySubscription();
    mockApi.subagentsList.mockResolvedValue([subagentEntry({ status: 'running' })]);
    await selectParentWithAgent();
    useChatStore.getState().subscribeSubagent('sub_a');
    await useChatStore.getState().refreshSubagents();

    await useChatStore.getState().resumeSubagent('sub_a', 'keep going');

    expect(useChatStore.getState().subagentUi.sub_a.transcript).toHaveLength(1);
  });

  it('takes the row back when the gateway refuses the message', async () => {
    await selectParentWithAgent();
    mockApi.subagentsList.mockResolvedValue([subagentEntry()]);
    mockApi.subagentResume.mockResolvedValue({ ok: false, reason: 'steer cap reached' });
    useChatStore.getState().subscribeSubagent('sub_a');
    await useChatStore.getState().refreshSubagents();

    await useChatStore.getState().resumeSubagent('sub_a', 'once more');

    expect(useChatStore.getState().subagentUi.sub_a.transcript ?? []).toEqual([]);
    expect(useChatStore.getState().subagentUi.sub_a.notice).toBe('steer cap reached');
    expect(useChatStore.getState().subagentUi.sub_a.draft).toBe('');
  });
});
