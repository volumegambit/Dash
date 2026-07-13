import type { ConversationRef, McConversationView } from '@dash/mc';
import type { ConversationMessage, MobileWsServerFrame } from '@dash/mobile-contract';
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
