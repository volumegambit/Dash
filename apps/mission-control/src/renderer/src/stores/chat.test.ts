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
    await useChatStore.getState().applyFrame(eventFrame('worker_done'));
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
