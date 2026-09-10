import type { ConversationRef, McConversationView } from '@dash/mc';
import type { ConversationMessage, MobileWsServerFrame } from '@dash/mobile-contract';
import type {
  MobileV2ConversationBootstrap,
  MobileV2ConversationSummary,
  MobileV2PendingInput,
  MobileV2SequencedFrame,
} from '@dash/mobile-contract-v2';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockApi } from '../../../../vitest.setup.js';
import { conversationKey, conversationSourceFor, initChatListeners, useChatStore } from './chat.js';

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

const v2Summary: MobileV2ConversationSummary = {
  id: gatewayConversation.id,
  agentId: gatewayConversation.agentId,
  agentName: gatewayConversation.agentName,
  title: gatewayConversation.title,
  revision: gatewayConversation.revision,
  status: 'running',
  activeTurnId: 'run-1',
  owningIssueId: null,
  projectId: null,
  lastSeq: 0,
  lastMessagePreview: null,
  createdAt: gatewayConversation.createdAt,
  updatedAt: gatewayConversation.updatedAt,
  queuePaused: false,
  queueRevision: 1,
  pendingFollowUpCount: 0,
  v2LastSeq: 12,
};

function v2Bootstrap(
  patch: Partial<MobileV2ConversationBootstrap> = {},
): MobileV2ConversationBootstrap {
  return {
    conversation: v2Summary,
    messages: [],
    nextCursor: null,
    pendingInputs: [],
    queuePaused: false,
    queueRevision: 1,
    v2ThroughSeq: 12,
    ...patch,
  };
}

function v2Accepted(
  runId: string,
  v2Seq: number,
): Extract<MobileV2SequencedFrame, { type: 'accepted' }> {
  return {
    type: 'accepted',
    id: runId,
    conversationId: gatewayConversation.id,
    runId,
    segmentTurnId: `${runId}:segment`,
    userMessageId: `${runId}:user`,
    assistantMessageId: `${runId}:assistant`,
    revision: 5,
    v2Seq,
  };
}

function acceptedInput(
  commandId: string,
  inputId: string,
  v2Seq = 13,
): Extract<MobileV2SequencedFrame, { type: 'input_accepted' }> {
  const input: MobileV2PendingInput = {
    inputId,
    kind: 'follow_up',
    text: 'next task',
    state: 'queued',
    revision: 2,
    enqueueOrder: 1,
    createdAt: gatewayConversation.createdAt,
    updatedAt: gatewayConversation.updatedAt,
  };
  return {
    type: 'input_accepted',
    id: commandId,
    conversationId: gatewayConversation.id,
    v2Seq,
    queueRevision: 2,
    input,
  };
}

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

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.restoreAllMocks();
  mockApi.chatListConversations.mockReset();
  mockApi.chatGetConversation.mockReset();
  mockApi.chatGetMessages.mockReset();
  mockApi.chatGetInitialState.mockReset();
  mockApi.chatGetOlderMessages.mockReset();
  mockApi.chatCreateConversation.mockReset();
  mockApi.chatSend.mockReset();
  mockApi.chatSubscribeV2.mockReset();
  mockApi.chatUnsubscribeV2.mockReset();
  mockApi.chatEnqueueInput.mockReset();
  mockApi.chatEditFollowUp.mockReset();
  mockApi.chatRemoveFollowUp.mockReset();
  mockApi.chatResumeFollowUps.mockReset();
  mockApi.chatCancel.mockReset();
  mockApi.chatAnswerQuestion.mockReset();
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
    connectionIssue: null,
    protocolByConversation: {},
    v2Projections: {},
    subscribedV2Conversations: {},
    openingPromiseByConversation: {},
    openGenerationByConversation: {},
    projectionEpochByConversation: {},
    conversationOwnersByConversation: {},
    ordinarySendIntentsByConversation: {},
    pendingV2LegacyCommandsByConversation: {},
    commandIssuesByConversation: {},
    answerAttemptsByConversation: {},
    mainChatSurfaceGeneration: 0,
    mainChatSurfaceActive: false,
    mainChatSelectionGeneration: 0,
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
      protocol: 'v1',
      frame: {
        type: 'accepted',
        id: turnId,
        conversationId: ref.id,
        userMessageId: 'canonical-user',
        assistantMessageId: 'canonical-assistant',
        revision: 3,
        seq: 1,
      },
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

    expect(mockApi.chatCancel).toHaveBeenCalledWith(ref, 'remote-turn', expect.any(String));
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

    expect(mockApi.chatCancel).toHaveBeenCalledWith(ref, 'local-turn', expect.any(String));
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

describe('conversation v2 store', () => {
  const ref = { id: gatewayConversation.id, origin: 'gateway' as const };
  const key = 'gateway:shared-id' as const;

  beforeEach(() => {
    useChatStore.setState({
      conversations: [gatewayConversation],
      conversationAuthority: 'gateway',
      gatewayOnline: true,
    });
    mockApi.chatSubscribeV2.mockResolvedValue(undefined);
    mockApi.chatUnsubscribeV2.mockResolvedValue(undefined);
    mockApi.chatGetMessages.mockResolvedValue({ items: [], nextCursor: null, throughSeq: 0 });
  });

  it('uses only the protocol-authoritative summary', () => {
    useChatStore.setState({
      conversations: [{ ...gatewayConversation, activeTurnId: 'stale-v1' }],
      protocolByConversation: { [key]: 'v2' },
      v2Projections: {},
    });
    expect(conversationSourceFor(useChatStore.getState(), ref)).toBeNull();

    useChatStore.setState({
      v2Projections: {
        [key]: {
          conversation: v2Summary,
        } as never,
      },
    });
    expect(conversationSourceFor(useChatStore.getState(), ref)).toEqual({
      protocol: 'v2',
      summary: v2Summary,
    });
  });

  it('uses the protocol-authoritative v2 revision for rename and delete', async () => {
    useChatStore.setState({
      conversations: [{ ...gatewayConversation, revision: 1 }],
    });
    mockApi.chatGetInitialState.mockResolvedValue({
      protocol: 'v2',
      bootstrap: v2Bootstrap({
        conversation: {
          ...v2Summary,
          revision: 9,
          status: 'idle',
          activeTurnId: null,
        },
      }),
    });
    await useChatStore.getState().openConversation(ref, 'main-chat');
    mockApi.chatRenameConversation.mockResolvedValue({
      ...gatewayConversation,
      revision: 10,
      title: 'Renamed',
    });

    await useChatStore.getState().renameConversation(ref, 'Renamed');
    expect(mockApi.chatRenameConversation).toHaveBeenCalledWith(ref, 9, 'Renamed');

    useChatStore.setState({ conversations: [{ ...gatewayConversation, revision: 1 }] });
    mockApi.chatDeleteConversation.mockResolvedValue(undefined);
    await useChatStore.getState().deleteConversation(ref);
    expect(mockApi.chatDeleteConversation).toHaveBeenCalledWith(ref, 10);
  });

  it('preserves v2 lifecycle state when reconciling a partial rename conflict', async () => {
    useChatStore.setState({
      conversations: [
        {
          ...gatewayConversation,
          revision: 1,
          status: 'running',
          activeTurnId: 'stale-legacy-run',
        },
      ],
    });
    mockApi.chatGetInitialState.mockResolvedValue({
      protocol: 'v2',
      bootstrap: v2Bootstrap({
        conversation: {
          ...v2Summary,
          revision: 9,
          status: 'idle',
          activeTurnId: null,
        },
      }),
    });
    await useChatStore.getState().openConversation(ref, 'main-chat');
    mockApi.chatRenameConversation.mockRejectedValue({
      code: 'revision_conflict',
      details: { current: { revision: 10, title: 'Server title' } },
    });

    await expect(
      useChatStore.getState().renameConversation(ref, 'Client title'),
    ).rejects.toBeDefined();

    expect(useChatStore.getState().v2Projections[key]?.conversation).toMatchObject({
      revision: 10,
      title: 'Server title',
      status: 'idle',
      activeTurnId: null,
    });
    mockApi.chatDeleteConversation.mockResolvedValue(undefined);
    await useChatStore.getState().deleteConversation(ref);
    expect(mockApi.chatDeleteConversation).toHaveBeenCalledWith(ref, 10);
  });

  it('coalesces concurrent owners through one bootstrap and subscription', async () => {
    const initial = deferred<Awaited<ReturnType<typeof window.api.chatGetInitialState>>>();
    const subscribed = deferred<void>();
    mockApi.chatGetInitialState.mockReturnValue(initial.promise);
    mockApi.chatSubscribeV2.mockReturnValue(subscribed.promise);

    const first = useChatStore.getState().openConversation(ref, 'main-chat');
    const generation = useChatStore.getState().openGenerationByConversation[key];
    const second = useChatStore.getState().openConversation(ref, 'session-panel:1');

    expect(first).toBe(second);
    expect(useChatStore.getState().openingPromiseByConversation[key]).toBe(first);
    expect(useChatStore.getState().conversationOwnersByConversation[key]).toEqual([
      'main-chat',
      'session-panel:1',
    ]);
    expect(useChatStore.getState().openGenerationByConversation[key]).toBe(generation);
    expect(mockApi.chatGetInitialState).toHaveBeenCalledTimes(1);

    initial.resolve({ protocol: 'v2', bootstrap: v2Bootstrap() });
    await Promise.resolve();
    expect(useChatStore.getState().v2Projections[key]?.lastAppliedV2Seq).toBe(12);
    expect(mockApi.chatSubscribeV2).toHaveBeenCalledWith(ref, 12);

    await useChatStore.getState().closeConversation(ref, 'main-chat');
    expect(mockApi.chatUnsubscribeV2).not.toHaveBeenCalled();
    subscribed.resolve();
    await Promise.all([first, second]);
    await useChatStore.getState().closeConversation(ref, 'session-panel:1');
    expect(mockApi.chatUnsubscribeV2).toHaveBeenCalledOnce();
  });

  it('invalidates a pending bootstrap when its final owner closes', async () => {
    const initial = deferred<Awaited<ReturnType<typeof window.api.chatGetInitialState>>>();
    mockApi.chatGetInitialState.mockReturnValue(initial.promise);

    const opening = useChatStore.getState().openConversation(ref, 'main-chat');
    const generation = useChatStore.getState().openGenerationByConversation[key];
    await useChatStore.getState().closeConversation(ref, 'main-chat');
    expect(useChatStore.getState().openGenerationByConversation[key]).toBe(generation + 1);

    initial.resolve({ protocol: 'v2', bootstrap: v2Bootstrap() });
    await opening;

    expect(useChatStore.getState().v2Projections[key]).toBeUndefined();
    expect(useChatStore.getState().subscribedV2Conversations[key]).toBeUndefined();
    expect(mockApi.chatSubscribeV2).not.toHaveBeenCalled();
    expect(mockApi.chatUnsubscribeV2).toHaveBeenCalledOnce();
  });

  it('shares the opening promise when a second owner arrives during subscribe', async () => {
    const subscribed = deferred<void>();
    mockApi.chatGetInitialState.mockResolvedValue({ protocol: 'v2', bootstrap: v2Bootstrap() });
    mockApi.chatSubscribeV2.mockReturnValue(subscribed.promise);

    const first = useChatStore.getState().openConversation(ref, 'main-chat');
    await vi.waitFor(() => expect(mockApi.chatSubscribeV2).toHaveBeenCalledOnce());
    const second = useChatStore.getState().openConversation(ref, 'session-panel:1');
    expect(mockApi.chatGetInitialState).toHaveBeenCalledOnce();
    subscribed.resolve();
    await Promise.all([first, second]);
    expect(mockApi.chatSubscribeV2).toHaveBeenCalledOnce();
  });

  it('hydrates a remote accepted replay received while the v2 subscribe is pending', async () => {
    const subscribed = deferred<void>();
    const canonicalUser = {
      id: 'remote-run:user',
      conversationId: ref.id,
      turnId: 'remote-run:segment',
      runId: 'remote-run',
      segmentIndex: 0,
      deliveryKind: 'normal' as const,
      ordinal: 1,
      role: 'user' as const,
      status: 'completed' as const,
      content: { type: 'user' as const, text: 'Remote user text' },
      createdAt: gatewayConversation.createdAt,
      updatedAt: gatewayConversation.updatedAt,
    };
    mockApi.chatGetInitialState
      .mockResolvedValueOnce({ protocol: 'v2', bootstrap: v2Bootstrap() })
      .mockResolvedValueOnce({
        protocol: 'v2',
        bootstrap: v2Bootstrap({
          conversation: {
            ...v2Summary,
            revision: 5,
            status: 'running',
            activeTurnId: 'remote-run',
            v2LastSeq: 13,
          },
          messages: [canonicalUser],
          v2ThroughSeq: 13,
        }),
      });
    mockApi.chatSubscribeV2
      .mockReturnValueOnce(subscribed.promise)
      .mockResolvedValueOnce(undefined);

    const opening = useChatStore.getState().openConversation(ref, 'main-chat');
    await vi.waitFor(() => expect(mockApi.chatSubscribeV2).toHaveBeenCalledOnce());
    const generation = useChatStore.getState().openGenerationByConversation[key];
    const applying = useChatStore.getState().applyV2Frame(v2Accepted('remote-run', 13));
    await Promise.resolve();

    expect(mockApi.chatGetInitialState).toHaveBeenCalledOnce();
    expect(useChatStore.getState().v2Projections[key].messages[canonicalUser.id]).toBeUndefined();
    subscribed.resolve();
    await Promise.all([opening, applying]);

    expect(mockApi.chatGetInitialState).toHaveBeenCalledTimes(2);
    expect(mockApi.chatSubscribeV2).toHaveBeenCalledTimes(2);
    expect(useChatStore.getState().v2Projections[key].messages[canonicalUser.id]?.content).toEqual(
      canonicalUser.content,
    );
    expect(useChatStore.getState().conversationOwnersByConversation[key]).toEqual(['main-chat']);
    expect(useChatStore.getState().openGenerationByConversation[key]).toBe(generation);
  });

  it('records an ordinary-send intent before IPC and converges push-before-promise', async () => {
    mockApi.chatGetInitialState.mockResolvedValue({
      protocol: 'v2',
      bootstrap: v2Bootstrap({
        conversation: { ...v2Summary, status: 'idle', activeTurnId: null },
      }),
    });
    mockApi.chatSubscribeV2.mockResolvedValue(undefined);
    await useChatStore.getState().openConversation(ref, 'main-chat');
    const result = deferred<Awaited<ReturnType<typeof window.api.chatSend>>>();
    mockApi.chatSend.mockReturnValue(result.promise);

    const pending = useChatStore
      .getState()
      .sendMessage(ref, 'hello', [{ mediaType: 'image/png', data: 'AA==' }], 7);
    const turnId = mockApi.chatSend.mock.calls[0][1] as string;
    expect(useChatStore.getState().ordinarySendIntentsByConversation[key]?.[turnId]).toMatchObject({
      turnId,
      text: 'hello',
      draftRevision: 7,
    });
    const frame = v2Accepted(turnId, 13);
    await useChatStore.getState().applyV2Frame(frame);
    expect(useChatStore.getState().v2Projections[key].messages[frame.userMessageId]).toMatchObject({
      content: { type: 'user', text: 'hello' },
    });
    result.resolve({ protocol: 'v2', frame });
    await pending;

    const projection = useChatStore.getState().v2Projections[key];
    expect(
      projection.timeline.filter(
        (entry) => entry.kind === 'message' && entry.messageId === frame.userMessageId,
      ),
    ).toHaveLength(1);
    expect(
      useChatStore.getState().ordinarySendIntentsByConversation[key]?.[turnId],
    ).toBeUndefined();
  });

  it('converges an ordinary send when the promise acknowledgement arrives before the push', async () => {
    mockApi.chatGetInitialState.mockResolvedValue({
      protocol: 'v2',
      bootstrap: v2Bootstrap({
        conversation: { ...v2Summary, status: 'idle', activeTurnId: null },
      }),
    });
    await useChatStore.getState().openConversation(ref, 'main-chat');
    mockApi.chatSend.mockImplementation(async (_conversation, turnId) => ({
      protocol: 'v2',
      frame: v2Accepted(turnId, 13),
    }));

    await useChatStore.getState().sendMessage(ref, 'promise first', undefined, 11);
    const turnId = mockApi.chatSend.mock.calls[0][1] as string;
    const frame = v2Accepted(turnId, 13);
    await useChatStore.getState().applyV2Frame(frame);

    const projection = useChatStore.getState().v2Projections[key];
    expect(
      projection.timeline.filter(
        (entry) => entry.kind === 'message' && entry.messageId === frame.userMessageId,
      ),
    ).toHaveLength(1);
    expect(
      projection.timeline.filter(
        (entry) =>
          entry.kind === 'assistant_segment' &&
          entry.assistantMessageId === frame.assistantMessageId,
      ),
    ).toHaveLength(1);
    expect(projection.lastAppliedV2Seq).toBe(13);
  });

  it('rejects a protocol-mismatched send without clearing its retry intent', async () => {
    mockApi.chatGetInitialState.mockResolvedValue({
      protocol: 'v2',
      bootstrap: v2Bootstrap({
        conversation: { ...v2Summary, status: 'idle', activeTurnId: null },
      }),
    });
    await useChatStore.getState().openConversation(ref, 'main-chat');
    mockApi.chatSend.mockResolvedValue({
      protocol: 'v1',
      frame: {
        type: 'accepted',
        id: 'wrong',
        conversationId: ref.id,
        userMessageId: 'u',
        assistantMessageId: 'a',
        revision: 1,
        seq: 1,
      },
    });

    await expect(useChatStore.getState().sendMessage(ref, 'keep me', undefined, 2)).rejects.toThrow(
      'protocol',
    );
    expect(
      Object.values(useChatStore.getState().ordinarySendIntentsByConversation[key]),
    ).toHaveLength(1);
  });

  it('rejects an undefined v2 gateway acknowledgement and retains its retry intent', async () => {
    mockApi.chatGetInitialState.mockResolvedValue({
      protocol: 'v2',
      bootstrap: v2Bootstrap({
        conversation: { ...v2Summary, status: 'idle', activeTurnId: null },
      }),
    });
    await useChatStore.getState().openConversation(ref, 'main-chat');
    mockApi.chatSend.mockResolvedValue(undefined);

    await expect(
      useChatStore.getState().sendMessage(ref, 'retry me', undefined, 3),
    ).rejects.toThrow('undefined');

    expect(Object.values(useChatStore.getState().ordinarySendIntentsByConversation[key])).toEqual([
      expect.objectContaining({ text: 'retry me', draftRevision: 3 }),
    ]);
  });

  it('routes tagged v1 acknowledgements only to v1 and accepts undefined only for local legacy', async () => {
    mockApi.chatGetInitialState.mockResolvedValue({
      protocol: 'v1',
      page: { items: [], nextCursor: null, throughSeq: 0 },
    });
    await useChatStore.getState().openConversation(ref, 'main-chat');
    mockApi.chatSend.mockImplementationOnce(async (_conversation, turnId) => ({
      protocol: 'v1',
      frame: {
        type: 'accepted',
        id: turnId,
        conversationId: ref.id,
        userMessageId: 'canonical-user',
        assistantMessageId: 'canonical-assistant',
        revision: 3,
        seq: 1,
      },
    }));
    await useChatStore.getState().sendMessage(ref, 'v1');
    expect(useChatStore.getState().messages[key].map((item) => item.id)).toContain(
      'canonical-user',
    );

    useChatStore.setState({ conversations: [gatewayConversation] });
    mockApi.chatSend.mockResolvedValueOnce({
      protocol: 'v2',
      frame: v2Accepted('wrong-protocol', 1),
    });
    await expect(useChatStore.getState().sendMessage(ref, 'wrong tag')).rejects.toThrow('protocol');

    mockApi.chatSend.mockResolvedValueOnce(undefined);
    await expect(useChatStore.getState().sendMessage(ref, 'gateway undefined')).rejects.toThrow(
      'undefined',
    );

    const localRef = { id: localConversation.id, origin: 'local' as const };
    useChatStore.setState((state) => ({
      conversations: [...state.conversations, localConversation],
    }));
    mockApi.chatGetInitialState.mockResolvedValueOnce({
      protocol: 'v1',
      page: { items: [], nextCursor: null, throughSeq: 0 },
    });
    await useChatStore.getState().openConversation(localRef, 'session-panel:local');
    mockApi.chatSend.mockResolvedValueOnce(undefined);
    await expect(
      useChatStore.getState().sendMessage(localRef, 'local legacy'),
    ).resolves.toBeUndefined();
  });

  it('uses distinct command/input IDs and resolves only after durable input acceptance', async () => {
    mockApi.chatGetInitialState.mockResolvedValue({ protocol: 'v2', bootstrap: v2Bootstrap() });
    await useChatStore.getState().openConversation(ref, 'main-chat');
    mockApi.chatEnqueueInput.mockImplementation(async (_ref, request) =>
      acceptedInput(request.commandId, request.inputId),
    );

    await expect(
      useChatStore.getState().enqueueInput(ref, { behavior: 'followUp', text: 'next task' }),
    ).resolves.toMatchObject({ inputId: expect.any(String), text: 'next task' });
    const request = mockApi.chatEnqueueInput.mock.calls[0][1];
    expect(request.commandId).not.toBe(request.inputId);
    expect(useChatStore.getState().v2Projections[key].queueOrder).toEqual([request.inputId]);
  });

  it('clears a matching command issue only when the local queue return path settles', async () => {
    mockApi.chatGetInitialState.mockResolvedValue({ protocol: 'v2', bootstrap: v2Bootstrap() });
    await useChatStore.getState().openConversation(ref, 'main-chat');
    const result = deferred<Extract<MobileV2SequencedFrame, { type: 'input_accepted' }>>();
    mockApi.chatEnqueueInput.mockReturnValue(result.promise);

    const pending = useChatStore
      .getState()
      .enqueueInput(ref, { behavior: 'followUp', text: 'next task' });
    const request = mockApi.chatEnqueueInput.mock.calls[0][1];
    const frame = acceptedInput(request.commandId, request.inputId);
    useChatStore.setState({
      commandIssuesByConversation: {
        [key]: {
          conversation: ref,
          commandId: request.commandId,
          kind: 'cancel',
          localDispatchToken: 'issue-token',
          ambiguousCorrelation: false,
          apiError: {
            code: 'revision_conflict',
            error: 'Pending issue',
            retryable: true,
          },
        },
      },
    });

    await useChatStore.getState().applyV2Frame(frame);
    expect(useChatStore.getState().commandIssuesByConversation[key]?.apiError.error).toBe(
      'Pending issue',
    );

    result.resolve(frame);
    await pending;
    expect(useChatStore.getState().commandIssuesByConversation[key]).toBeUndefined();
  });

  it('keeps the promoted run authoritative for Stop and ignores a late old terminal', async () => {
    mockApi.chatGetInitialState.mockResolvedValue({ protocol: 'v2', bootstrap: v2Bootstrap() });
    await useChatStore.getState().openConversation(ref, 'main-chat');
    await useChatStore.getState().applyV2Frame({
      type: 'done',
      id: 'run-1',
      conversationId: ref.id,
      runId: 'run-1',
      segmentTurnId: 'run-1:segment',
      v2Seq: 13,
      outcome: 'cancelled',
    });
    await useChatStore.getState().applyV2Frame(v2Accepted('run-2', 14));
    await useChatStore.getState().applyV2Frame({
      type: 'done',
      id: 'run-1',
      conversationId: ref.id,
      runId: 'run-1',
      segmentTurnId: 'run-1:segment',
      v2Seq: 15,
      outcome: 'cancelled',
    });

    useChatStore.getState().cancelMessage(ref);
    expect(mockApi.chatCancel.mock.calls[0][1]).toBe('run-2');
    expect(conversationSourceFor(useChatStore.getState(), ref)?.summary.activeTurnId).toBe('run-2');
  });

  it('admits a contextual answer issue without terminalizing the run', async () => {
    mockApi.chatGetInitialState.mockResolvedValue({ protocol: 'v2', bootstrap: v2Bootstrap() });
    await useChatStore.getState().openConversation(ref, 'session-panel:1');
    useChatStore.getState().answerQuestion(ref, 'question-1', 'answer');
    const token = Object.keys(
      useChatStore.getState().pendingV2LegacyCommandsByConversation[key],
    )[0];

    useChatStore.getState().handleV2CommandIssue({
      conversation: ref,
      commandId: 'run-1',
      kind: 'answer',
      localDispatchToken: token,
      questionId: 'question-1',
      ambiguousCorrelation: false,
      apiError: {
        code: 'revision_conflict',
        error: 'Question is no longer active',
        retryable: false,
      },
    });

    expect(useChatStore.getState().answerAttemptsByConversation[key]['question-1']).toMatchObject({
      answer: 'answer',
      state: 'rejected',
    });
    expect(useChatStore.getState().commandIssuesByConversation[key]?.apiError.error).toBe(
      'Question is no longer active',
    );
    expect(useChatStore.getState().connectionIssue).toBeNull();
    expect(useChatStore.getState().v2Projections[key].conversation.activeTurnId).toBe('run-1');
  });

  it('uses collision-safe answer tokens and rejects only the targeted tentative answer', async () => {
    mockApi.chatGetInitialState.mockResolvedValue({ protocol: 'v2', bootstrap: v2Bootstrap() });
    await useChatStore.getState().openConversation(ref, 'session-panel:1');
    useChatStore.getState().answerQuestion(ref, 'question-1', 'first');
    useChatStore.getState().answerQuestion(ref, 'question-2', 'second');
    const commands = Object.values(
      useChatStore.getState().pendingV2LegacyCommandsByConversation[key],
    );
    expect(commands).toHaveLength(2);
    expect(new Set(commands.map((command) => command.localDispatchToken)).size).toBe(2);
    expect(commands.map((command) => command.wireCommandId)).toEqual(['run-1', 'run-1']);

    useChatStore.getState().handleV2CommandIssue({
      conversation: ref,
      commandId: 'run-1',
      kind: 'answer',
      localDispatchToken: 'remote-ambiguous-token',
      ambiguousCorrelation: true,
      apiError: {
        code: 'revision_conflict',
        error: 'Ambiguous command',
        retryable: false,
      },
    });
    expect(useChatStore.getState().answerAttemptsByConversation[key]).toMatchObject({
      'question-1': { state: 'pending' },
      'question-2': { state: 'pending' },
    });

    useChatStore.getState().handleV2CommandIssue({
      conversation: ref,
      commandId: 'run-1',
      kind: 'answer',
      localDispatchToken: 'remote-contextual-token',
      questionId: 'question-1',
      ambiguousCorrelation: false,
      apiError: {
        code: 'revision_conflict',
        error: 'First question ended',
        retryable: false,
      },
    });
    expect(useChatStore.getState().answerAttemptsByConversation[key]).toMatchObject({
      'question-1': { answer: 'first', state: 'rejected' },
      'question-2': { answer: 'second', state: 'pending' },
    });
  });

  it('keeps an answer tentative through model events and supports retry after rejection', async () => {
    mockApi.chatGetInitialState.mockResolvedValue({ protocol: 'v2', bootstrap: v2Bootstrap() });
    await useChatStore.getState().openConversation(ref, 'main-chat');
    useChatStore.getState().answerQuestion(ref, 'question-1', 'first answer');
    const firstToken = Object.keys(
      useChatStore.getState().pendingV2LegacyCommandsByConversation[key],
    )[0];

    await useChatStore.getState().applyV2Frame({
      type: 'event',
      id: 'run-1',
      conversationId: ref.id,
      runId: 'run-1',
      segmentTurnId: 'run-1:segment',
      v2Seq: 13,
      event: { type: 'text_delta', text: 'still working' },
    });
    expect(useChatStore.getState().answerAttemptsByConversation[key]['question-1'].state).toBe(
      'pending',
    );

    useChatStore.getState().handleV2CommandIssue({
      conversation: ref,
      commandId: 'run-1',
      kind: 'answer',
      localDispatchToken: firstToken,
      questionId: 'question-1',
      ambiguousCorrelation: false,
      apiError: {
        code: 'revision_conflict',
        error: 'Please retry',
        retryable: true,
      },
    });
    expect(useChatStore.getState().answerAttemptsByConversation[key]['question-1']).toMatchObject({
      answer: 'first answer',
      state: 'rejected',
    });

    useChatStore.getState().answerQuestion(ref, 'question-1', 'second answer');
    expect(useChatStore.getState().answerAttemptsByConversation[key]['question-1']).toMatchObject({
      answer: 'second answer',
      state: 'pending',
    });
  });

  it('ends tentative answers on terminal frames without confirming them', async () => {
    mockApi.chatGetInitialState.mockResolvedValue({ protocol: 'v2', bootstrap: v2Bootstrap() });
    await useChatStore.getState().openConversation(ref, 'main-chat');
    useChatStore.getState().answerQuestion(ref, 'question-1', 'answer');
    await useChatStore.getState().applyV2Frame({
      type: 'error',
      id: 'run-1',
      conversationId: ref.id,
      runId: 'run-1',
      segmentTurnId: 'run-1:segment',
      v2Seq: 13,
      error: 'failed',
      retryable: false,
    });
    expect(useChatStore.getState().answerAttemptsByConversation[key]['question-1'].state).toBe(
      'ended',
    );
  });

  it.each(['completed', 'cancelled', 'interrupted', 'failed'] as const)(
    'ends tentative answers on a %s terminal without closing the subscription',
    async (outcome) => {
      mockApi.chatGetInitialState.mockResolvedValue({ protocol: 'v2', bootstrap: v2Bootstrap() });
      await useChatStore.getState().openConversation(ref, 'main-chat');
      useChatStore.getState().answerQuestion(ref, 'question-1', 'answer');

      if (outcome === 'failed') {
        await useChatStore.getState().applyV2Frame({
          type: 'error',
          id: 'run-1',
          conversationId: ref.id,
          runId: 'run-1',
          segmentTurnId: 'run-1:segment',
          v2Seq: 13,
          error: 'failed',
          retryable: false,
        });
      } else {
        await useChatStore.getState().applyV2Frame({
          type: 'done',
          id: 'run-1',
          conversationId: ref.id,
          runId: 'run-1',
          segmentTurnId: 'run-1:segment',
          v2Seq: 13,
          outcome,
        });
      }

      expect(useChatStore.getState().answerAttemptsByConversation[key]['question-1'].state).toBe(
        'ended',
      );
      expect(useChatStore.getState().subscribedV2Conversations[key]).toEqual(ref);
      expect(mockApi.chatUnsubscribeV2).not.toHaveBeenCalled();
    },
  );

  it('reconciles tentative answers and command contexts across bootstrap replacement', async () => {
    mockApi.chatGetInitialState.mockResolvedValueOnce({
      protocol: 'v2',
      bootstrap: v2Bootstrap(),
    });
    await useChatStore.getState().openConversation(ref, 'main-chat');
    useChatStore.getState().answerQuestion(ref, 'question-1', 'answer');
    const token = Object.keys(
      useChatStore.getState().pendingV2LegacyCommandsByConversation[key],
    )[0];
    useChatStore.getState().handleV2CommandIssue({
      conversation: ref,
      commandId: 'run-1',
      kind: 'answer',
      localDispatchToken: token,
      questionId: 'question-1',
      ambiguousCorrelation: false,
      apiError: {
        code: 'revision_conflict',
        error: 'Rejected',
        retryable: true,
      },
    });
    useChatStore.getState().clearCommandIssue(ref);

    mockApi.chatGetInitialState.mockResolvedValueOnce({
      protocol: 'v2',
      bootstrap: v2Bootstrap({
        conversation: { ...v2Summary, v2LastSeq: 14 },
        v2ThroughSeq: 14,
      }),
    });
    await useChatStore.getState().applyV2Frame({
      type: 'event',
      id: 'run-1',
      conversationId: ref.id,
      runId: 'run-1',
      segmentTurnId: 'run-1:segment',
      v2Seq: 14,
      event: { type: 'text_delta', text: 'gap' },
    });
    expect(useChatStore.getState().answerAttemptsByConversation[key]['question-1'].state).toBe(
      'rejected',
    );
    expect(useChatStore.getState().pendingV2LegacyCommandsByConversation[key][token]).toBeDefined();

    mockApi.chatGetInitialState.mockResolvedValueOnce({
      protocol: 'v2',
      bootstrap: v2Bootstrap({
        conversation: {
          ...v2Summary,
          activeTurnId: 'run-2',
          revision: 9,
          v2LastSeq: 16,
        },
        v2ThroughSeq: 16,
      }),
    });
    await useChatStore.getState().applyV2Frame({
      type: 'event',
      id: 'run-2',
      conversationId: ref.id,
      runId: 'run-2',
      segmentTurnId: 'run-2:segment',
      v2Seq: 16,
      event: { type: 'text_delta', text: 'second gap' },
    });
    expect(useChatStore.getState().answerAttemptsByConversation[key]['question-1'].state).toBe(
      'ended',
    );
    expect(useChatStore.getState().pendingV2LegacyCommandsByConversation[key]).toEqual({});

    useChatStore.getState().handleV2CommandIssue({
      conversation: ref,
      commandId: 'run-1',
      kind: 'answer',
      localDispatchToken: token,
      questionId: 'question-1',
      ambiguousCorrelation: false,
      apiError: {
        code: 'revision_conflict',
        error: 'Late issue',
        retryable: false,
      },
    });
    expect(useChatStore.getState().commandIssuesByConversation[key]).toBeUndefined();
  });

  it('ignores an older page after a bootstrap replacement epoch', async () => {
    mockApi.chatGetInitialState.mockResolvedValue({
      protocol: 'v2',
      bootstrap: v2Bootstrap({ nextCursor: 'older' }),
    });
    await useChatStore.getState().openConversation(ref, 'main-chat');
    const older = deferred<Awaited<ReturnType<typeof window.api.chatGetOlderMessages>>>();
    mockApi.chatGetOlderMessages.mockReturnValue(older.promise);
    const pending = useChatStore.getState().loadOlderMessages(ref);
    useChatStore.setState((state) => ({
      projectionEpochByConversation: {
        ...state.projectionEpochByConversation,
        [key]: state.projectionEpochByConversation[key] + 1,
      },
    }));
    older.resolve({
      protocol: 'v2',
      page: { items: [], nextCursor: null, throughSeq: 3 },
    });
    await pending;
    expect(useChatStore.getState().v2Projections[key].nextCursor).toBe('older');
  });

  it('merges an older page after live frames because live traffic does not advance the epoch', async () => {
    const assistant = {
      id: 'assistant-1',
      conversationId: ref.id,
      turnId: 'run-1:segment',
      runId: 'run-1',
      segmentIndex: 1,
      deliveryKind: 'normal' as const,
      ordinal: 2,
      role: 'assistant' as const,
      status: 'streaming' as const,
      content: { type: 'assistant' as const, events: [] },
      createdAt: gatewayConversation.createdAt,
      updatedAt: gatewayConversation.updatedAt,
    };
    mockApi.chatGetInitialState.mockResolvedValue({
      protocol: 'v2',
      bootstrap: v2Bootstrap({ messages: [assistant], nextCursor: 'older' }),
    });
    await useChatStore.getState().openConversation(ref, 'main-chat');
    const epoch = useChatStore.getState().projectionEpochByConversation[key];
    const older = deferred<Awaited<ReturnType<typeof window.api.chatGetOlderMessages>>>();
    mockApi.chatGetOlderMessages.mockReturnValue(older.promise);

    const pending = useChatStore.getState().loadOlderMessages(ref);
    await useChatStore.getState().applyV2Frame({
      type: 'event',
      id: 'run-1',
      conversationId: ref.id,
      runId: 'run-1',
      segmentTurnId: 'run-1:segment',
      v2Seq: 13,
      event: { type: 'text_delta', text: 'live' },
    });
    older.resolve({
      protocol: 'v2',
      page: {
        items: [
          {
            id: 'older-user',
            conversationId: ref.id,
            turnId: 'old-run',
            runId: 'old-run',
            segmentIndex: 0,
            deliveryKind: 'normal',
            ordinal: 1,
            role: 'user',
            status: 'completed',
            content: { type: 'user', text: 'older' },
            createdAt: gatewayConversation.createdAt,
            updatedAt: gatewayConversation.updatedAt,
          },
        ],
        nextCursor: null,
        throughSeq: 2,
      },
    });
    await pending;

    const projection = useChatStore.getState().v2Projections[key];
    expect(useChatStore.getState().projectionEpochByConversation[key]).toBe(epoch);
    expect(projection.lastAppliedV2Seq).toBe(13);
    expect(projection.messages['older-user']).toBeDefined();
    expect(projection.liveSegments['assistant-1'].events).toEqual([
      { type: 'text_delta', text: 'live' },
    ]);
  });

  it('rejects an older-page protocol mismatch without changing v2 history', async () => {
    mockApi.chatGetInitialState.mockResolvedValue({
      protocol: 'v2',
      bootstrap: v2Bootstrap({ nextCursor: 'older' }),
    });
    await useChatStore.getState().openConversation(ref, 'main-chat');
    mockApi.chatGetOlderMessages.mockResolvedValue({
      protocol: 'v1',
      page: { items: [], nextCursor: null, throughSeq: 0 },
    });
    await expect(useChatStore.getState().loadOlderMessages(ref)).rejects.toThrow('protocol');
    expect(useChatStore.getState().v2Projections[key].nextCursor).toBe('older');
  });

  it('reserves selection so a delayed older intent cannot overwrite a newer selection', async () => {
    const refB = { id: 'conversation-b', origin: 'gateway' as const };
    const refC = { id: 'conversation-c', origin: 'gateway' as const };
    const b = deferred<McConversationView | null>();
    mockApi.chatGetConversation.mockImplementation((candidate) => {
      if (candidate.id === refB.id) return b.promise;
      return Promise.resolve({ ...gatewayConversation, id: refC.id });
    });
    const oldSelection = useChatStore.getState().selectConversation(refB);
    await useChatStore.getState().selectConversation(refC);
    b.resolve({ ...gatewayConversation, id: refB.id });
    await oldSelection;
    expect(useChatStore.getState().selectedConversationRef).toEqual(refC);
  });

  it('does not surface a stale not-found error after a newer selection wins', async () => {
    const refB = { id: 'conversation-b', origin: 'gateway' as const };
    const refC = { id: 'conversation-c', origin: 'gateway' as const };
    const b = deferred<McConversationView | null>();
    mockApi.chatGetConversation.mockImplementation((candidate) => {
      if (candidate.id === refB.id) return b.promise;
      return Promise.resolve({ ...gatewayConversation, id: refC.id });
    });

    const stale = useChatStore.getState().selectConversation(refB);
    await useChatStore.getState().selectConversation(refC);
    b.reject({ code: 'not_found' });
    await stale;

    expect(useChatStore.getState().selectedConversationRef).toEqual(refC);
    expect(useChatStore.getState().conversationError).toBeNull();
  });

  it('transfers only the main-chat owner while a SessionPanel keeps the prior socket open', async () => {
    const refB = { id: 'conversation-b', origin: 'gateway' as const };
    const keyB = conversationKey(refB);
    const conversationB = { ...gatewayConversation, id: refB.id, title: 'Conversation B' };
    useChatStore.setState({
      conversations: [gatewayConversation, conversationB],
      selectedConversationRef: ref,
      openTabKeys: [key, keyB],
    });
    mockApi.chatGetInitialState.mockImplementation(async (candidate) => ({
      protocol: 'v2',
      bootstrap: v2Bootstrap({
        conversation: { ...v2Summary, id: candidate.id, title: `Conversation ${candidate.id}` },
      }),
    }));

    const releaseMain = useChatStore.getState().retainMainChatSurface();
    await vi.waitFor(() =>
      expect(useChatStore.getState().subscribedV2Conversations[key]).toEqual(ref),
    );
    await useChatStore.getState().openConversation(ref, 'session-panel:1');
    await useChatStore.getState().selectConversation(refB);

    expect(useChatStore.getState().selectedConversationRef).toEqual(refB);
    expect(useChatStore.getState().conversationOwnersByConversation[key]).toEqual([
      'session-panel:1',
    ]);
    expect(useChatStore.getState().conversationOwnersByConversation[keyB]).toEqual(['main-chat']);
    expect(mockApi.chatUnsubscribeV2).not.toHaveBeenCalledWith(ref);

    await useChatStore.getState().closeConversation(ref, 'session-panel:1');
    expect(mockApi.chatUnsubscribeV2).toHaveBeenCalledTimes(1);
    expect(mockApi.chatUnsubscribeV2).toHaveBeenCalledWith(ref);
    releaseMain();
  });

  it('closing the selected tab transfers main-chat without releasing its SessionPanel owner', async () => {
    const refB = { id: 'conversation-b', origin: 'gateway' as const };
    const keyB = conversationKey(refB);
    useChatStore.setState({
      conversations: [gatewayConversation, { ...gatewayConversation, id: refB.id }],
      selectedConversationRef: ref,
      openTabKeys: [key, keyB],
    });
    mockApi.chatGetInitialState.mockImplementation(async (candidate) => ({
      protocol: 'v2',
      bootstrap: v2Bootstrap({ conversation: { ...v2Summary, id: candidate.id } }),
    }));

    const releaseMain = useChatStore.getState().retainMainChatSurface();
    await vi.waitFor(() =>
      expect(useChatStore.getState().subscribedV2Conversations[key]).toEqual(ref),
    );
    await useChatStore.getState().openConversation(ref, 'session-panel:1');
    useChatStore.getState().closeTab(key);
    await vi.waitFor(() =>
      expect(useChatStore.getState().subscribedV2Conversations[keyB]).toEqual(refB),
    );

    expect(useChatStore.getState().selectedConversationRef).toEqual(refB);
    expect(useChatStore.getState().conversationOwnersByConversation[key]).toEqual([
      'session-panel:1',
    ]);
    expect(useChatStore.getState().conversationOwnersByConversation[keyB]).toEqual(['main-chat']);
    expect(mockApi.chatUnsubscribeV2).not.toHaveBeenCalledWith(ref);

    await useChatStore.getState().closeConversation(ref, 'session-panel:1');
    expect(mockApi.chatUnsubscribeV2).toHaveBeenCalledWith(ref);
    releaseMain();
  });

  it('changes the selected tab without acquiring main-chat while its route lease is inactive', () => {
    const refB = { id: 'conversation-b', origin: 'gateway' as const };
    const keyB = conversationKey(refB);
    useChatStore.setState({
      conversations: [gatewayConversation, { ...gatewayConversation, id: refB.id }],
      selectedConversationRef: ref,
      openTabKeys: [key, keyB],
    });

    useChatStore.getState().closeTab(key);

    expect(useChatStore.getState().selectedConversationRef).toEqual(refB);
    expect(useChatStore.getState().conversationOwnersByConversation).toEqual({});
    expect(mockApi.chatGetInitialState).not.toHaveBeenCalled();
    expect(mockApi.chatSubscribeV2).not.toHaveBeenCalled();
  });

  it('moves the main-chat owner to a created conversation exactly once', async () => {
    const refB = { id: 'conversation-b', origin: 'gateway' as const };
    const keyB = conversationKey(refB);
    const conversationB = { ...gatewayConversation, id: refB.id, title: 'Conversation B' };
    useChatStore.setState({
      selectedConversationRef: ref,
      openTabKeys: [key],
    });
    mockApi.chatGetInitialState.mockImplementation(async (candidate) => ({
      protocol: 'v2',
      bootstrap: v2Bootstrap({
        conversation: { ...v2Summary, id: candidate.id, title: `Conversation ${candidate.id}` },
      }),
    }));
    mockApi.chatCreateConversation.mockResolvedValue(conversationB);

    const releaseMain = useChatStore.getState().retainMainChatSurface();
    await vi.waitFor(() =>
      expect(useChatStore.getState().subscribedV2Conversations[key]).toEqual(ref),
    );
    await useChatStore.getState().createConversation('agent-1');

    expect(useChatStore.getState().selectedConversationRef).toEqual(refB);
    expect(useChatStore.getState().conversationOwnersByConversation[key]).toBeUndefined();
    expect(useChatStore.getState().conversationOwnersByConversation[keyB]).toEqual(['main-chat']);
    expect(mockApi.chatUnsubscribeV2).toHaveBeenCalledTimes(1);
    expect(mockApi.chatUnsubscribeV2).toHaveBeenCalledWith(ref);
    expect(
      mockApi.chatSubscribeV2.mock.calls.filter(([candidate]) => candidate.id === refB.id),
    ).toHaveLength(1);
    releaseMain();
  });

  it('keeps an old-mount delayed selection from acquiring the remounted route owner', async () => {
    const refB = { id: 'conversation-b', origin: 'gateway' as const };
    const keyB = conversationKey(refB);
    const lookup = deferred<McConversationView | null>();
    useChatStore.setState({ selectedConversationRef: ref, openTabKeys: [key] });
    mockApi.chatGetInitialState.mockResolvedValue({
      protocol: 'v2',
      bootstrap: v2Bootstrap(),
    });
    mockApi.chatGetConversation.mockImplementation((candidate) =>
      candidate.id === refB.id ? lookup.promise : Promise.resolve(gatewayConversation),
    );

    const releaseOldMount = useChatStore.getState().retainMainChatSurface();
    await vi.waitFor(() =>
      expect(useChatStore.getState().subscribedV2Conversations[key]).toEqual(ref),
    );
    const staleSelection = useChatStore.getState().selectConversation(refB);
    releaseOldMount();
    const releaseNewMount = useChatStore.getState().retainMainChatSurface();
    await vi.waitFor(() =>
      expect(useChatStore.getState().conversationOwnersByConversation[key]).toEqual(['main-chat']),
    );

    lookup.resolve({ ...gatewayConversation, id: refB.id });
    await staleSelection;

    expect(useChatStore.getState().selectedConversationRef).toEqual(ref);
    expect(useChatStore.getState().conversationOwnersByConversation[key]).toEqual(['main-chat']);
    expect(useChatStore.getState().conversationOwnersByConversation[keyB]).toBeUndefined();
    expect(
      mockApi.chatSubscribeV2.mock.calls.filter(([candidate]) => candidate.id === refB.id),
    ).toHaveLength(0);
    releaseNewMount();
  });

  it('keeps a reselected remounted conversation when an older invalidation resolves missing', async () => {
    const refB = { id: 'conversation-b', origin: 'gateway' as const };
    const keyB = conversationKey(refB);
    const conversationB = { ...gatewayConversation, id: refB.id, title: 'Conversation B' };
    const missing = deferred<McConversationView | null>();
    useChatStore.setState({
      conversations: [gatewayConversation, conversationB],
      selectedConversationRef: ref,
      openTabKeys: [key, keyB],
    });
    mockApi.chatGetInitialState.mockImplementation(async (candidate) => ({
      protocol: 'v2',
      bootstrap: v2Bootstrap({
        conversation: { ...v2Summary, id: candidate.id, title: `Conversation ${candidate.id}` },
      }),
    }));
    mockApi.chatGetConversation.mockReturnValue(missing.promise);

    const releaseOldMount = useChatStore.getState().retainMainChatSurface();
    await vi.waitFor(() =>
      expect(useChatStore.getState().subscribedV2Conversations[key]).toEqual(ref),
    );
    const invalidation = useChatStore
      .getState()
      .invalidateConversation({ type: 'changed', conversation: ref });
    await vi.waitFor(() => expect(mockApi.chatGetConversation).toHaveBeenCalledWith(ref));

    await useChatStore.getState().selectConversation(refB);
    releaseOldMount();
    const releaseNewMount = useChatStore.getState().retainMainChatSurface();
    await vi.waitFor(() =>
      expect(useChatStore.getState().subscribedV2Conversations[keyB]).toEqual(refB),
    );
    await useChatStore.getState().selectConversation(ref);
    const unsubscribeCountBefore = mockApi.chatUnsubscribeV2.mock.calls.filter(
      ([candidate]) => candidate.id === ref.id,
    ).length;

    missing.resolve(null);
    await invalidation;

    expect(useChatStore.getState().selectedConversationRef).toEqual(ref);
    expect(useChatStore.getState().conversationOwnersByConversation[key]).toEqual(['main-chat']);
    expect(useChatStore.getState().subscribedV2Conversations[key]).toEqual(ref);
    expect(useChatStore.getState().v2Projections[key]).toBeDefined();
    expect(
      mockApi.chatUnsubscribeV2.mock.calls.filter(([candidate]) => candidate.id === ref.id),
    ).toHaveLength(unsubscribeCountBefore);
    releaseNewMount();
  });

  it('keeps a newly selected remounted conversation when its older unselected invalidation resolves missing', async () => {
    const refB = { id: 'conversation-b', origin: 'gateway' as const };
    const keyB = conversationKey(refB);
    const conversationB = { ...gatewayConversation, id: refB.id, title: 'Conversation B' };
    const missing = deferred<McConversationView | null>();
    useChatStore.setState({
      conversations: [gatewayConversation, conversationB],
      selectedConversationRef: ref,
      openTabKeys: [key, keyB],
    });
    mockApi.chatGetInitialState.mockImplementation(async (candidate) => ({
      protocol: 'v2',
      bootstrap: v2Bootstrap({
        conversation: { ...v2Summary, id: candidate.id, title: `Conversation ${candidate.id}` },
      }),
    }));
    mockApi.chatGetConversation.mockReturnValue(missing.promise);

    const releaseOldMount = useChatStore.getState().retainMainChatSurface();
    await vi.waitFor(() =>
      expect(useChatStore.getState().subscribedV2Conversations[key]).toEqual(ref),
    );
    const invalidation = useChatStore
      .getState()
      .invalidateConversation({ type: 'changed', conversation: refB });
    await vi.waitFor(() => expect(mockApi.chatGetConversation).toHaveBeenCalledWith(refB));

    await useChatStore.getState().selectConversation(refB);
    releaseOldMount();
    const releaseNewMount = useChatStore.getState().retainMainChatSurface();
    await vi.waitFor(() =>
      expect(useChatStore.getState().subscribedV2Conversations[keyB]).toEqual(refB),
    );
    const unsubscribeCountBefore = mockApi.chatUnsubscribeV2.mock.calls.filter(
      ([candidate]) => candidate.id === refB.id,
    ).length;

    missing.resolve(null);
    await invalidation;

    expect(useChatStore.getState().selectedConversationRef).toEqual(refB);
    expect(useChatStore.getState().conversationOwnersByConversation[keyB]).toEqual(['main-chat']);
    expect(useChatStore.getState().subscribedV2Conversations[keyB]).toEqual(refB);
    expect(useChatStore.getState().v2Projections[keyB]).toBeDefined();
    expect(
      mockApi.chatUnsubscribeV2.mock.calls.filter(([candidate]) => candidate.id === refB.id),
    ).toHaveLength(unsubscribeCountBefore);
    releaseNewMount();
  });

  it('ends old-run answer attempts and command contexts when a promoted run is accepted', async () => {
    mockApi.chatGetInitialState.mockResolvedValue({ protocol: 'v2', bootstrap: v2Bootstrap() });
    await useChatStore.getState().openConversation(ref, 'main-chat');
    useChatStore.getState().answerQuestion(ref, 'question-1', 'answer');
    useChatStore.setState((state) => ({
      ordinarySendIntentsByConversation: {
        ...state.ordinarySendIntentsByConversation,
        [key]: {
          'run-2': {
            turnId: 'run-2',
            text: 'promoted',
            submittedAt: gatewayConversation.updatedAt,
            draftRevision: 1,
          },
        },
      },
    }));

    await useChatStore.getState().applyV2Frame(v2Accepted('run-2', 13));

    expect(useChatStore.getState().answerAttemptsByConversation[key]['question-1'].state).toBe(
      'ended',
    );
    expect(
      Object.values(useChatStore.getState().pendingV2LegacyCommandsByConversation[key]),
    ).toEqual([]);
  });

  it('does not unsubscribe a negotiated v1 conversation on final owner release', async () => {
    mockApi.chatGetInitialState.mockResolvedValue({
      protocol: 'v1',
      page: { items: [], nextCursor: null, throughSeq: 0 },
    });
    await useChatStore.getState().openConversation(ref, 'main-chat');
    await useChatStore.getState().closeConversation(ref, 'main-chat');
    expect(mockApi.chatUnsubscribeV2).not.toHaveBeenCalled();
  });

  it('drops unknown and promoted-away command issues without changing the current alert', async () => {
    mockApi.chatGetInitialState.mockResolvedValue({ protocol: 'v2', bootstrap: v2Bootstrap() });
    await useChatStore.getState().openConversation(ref, 'main-chat');
    const issue = {
      conversation: ref,
      commandId: 'unknown-run',
      kind: 'cancel' as const,
      localDispatchToken: 'unknown-token',
      ambiguousCorrelation: false,
      apiError: {
        code: 'validation_failed' as const,
        error: 'Ignore me',
        retryable: false,
      },
    };
    useChatStore.getState().handleV2CommandIssue(issue);
    expect(useChatStore.getState().commandIssuesByConversation[key]).toBeUndefined();

    await useChatStore.getState().applyV2Frame(v2Accepted('run-2', 13));
    useChatStore.getState().handleV2CommandIssue({ ...issue, commandId: 'run-1' });
    expect(useChatStore.getState().commandIssuesByConversation[key]).toBeUndefined();
  });

  it('rejects a send acknowledgement after final-owner cleanup and keeps its retry intent', async () => {
    mockApi.chatGetInitialState.mockResolvedValue({
      protocol: 'v2',
      bootstrap: v2Bootstrap({
        conversation: { ...v2Summary, status: 'idle', activeTurnId: null },
      }),
    });
    await useChatStore.getState().openConversation(ref, 'main-chat');
    const result = deferred<Awaited<ReturnType<typeof window.api.chatSend>>>();
    mockApi.chatSend.mockReturnValue(result.promise);

    const pending = useChatStore.getState().sendMessage(ref, 'keep me', undefined, 3);
    const turnId = mockApi.chatSend.mock.calls[0][1] as string;
    await useChatStore.getState().closeConversation(ref, 'main-chat');
    result.resolve({ protocol: 'v2', frame: v2Accepted(turnId, 13) });

    await expect(pending).rejects.toThrow('subscription changed');
    expect(useChatStore.getState().ordinarySendIntentsByConversation[key][turnId]).toMatchObject({
      text: 'keep me',
      draftRevision: 3,
    });
    expect(useChatStore.getState().v2Projections[key].messages[`${turnId}:user`]).toBeUndefined();
  });

  it('rejects a queue acknowledgement after final-owner cleanup', async () => {
    mockApi.chatGetInitialState.mockResolvedValue({ protocol: 'v2', bootstrap: v2Bootstrap() });
    await useChatStore.getState().openConversation(ref, 'main-chat');
    const result = deferred<Extract<MobileV2SequencedFrame, { type: 'input_accepted' }>>();
    mockApi.chatEnqueueInput.mockReturnValue(result.promise);

    const pending = useChatStore
      .getState()
      .enqueueInput(ref, { behavior: 'followUp', text: 'keep queued draft' });
    const request = mockApi.chatEnqueueInput.mock.calls[0][1];
    await useChatStore.getState().closeConversation(ref, 'main-chat');
    result.resolve(acceptedInput(request.commandId, request.inputId));

    await expect(pending).rejects.toThrow('subscription changed');
    expect(useChatStore.getState().v2Projections[key].inputs[request.inputId]).toBeUndefined();
  });

  it('never sends an opened v2 conversation through the frozen v1 message-page API', async () => {
    mockApi.chatGetInitialState.mockResolvedValue({ protocol: 'v2', bootstrap: v2Bootstrap() });
    await useChatStore.getState().openConversation(ref, 'main-chat');

    await useChatStore.getState().ensureMessages(ref);

    expect(mockApi.chatGetMessages).not.toHaveBeenCalled();
  });

  it('refreshes and rebases in place on a revision conflict without unsubscribing', async () => {
    mockApi.chatGetInitialState.mockResolvedValueOnce({
      protocol: 'v2',
      bootstrap: v2Bootstrap(),
    });
    await useChatStore.getState().openConversation(ref, 'main-chat');
    mockApi.chatEnqueueInput.mockRejectedValue({
      apiError: {
        code: 'revision_conflict',
        error: 'Queue changed',
        retryable: true,
      },
    });
    mockApi.chatGetInitialState.mockResolvedValueOnce({
      protocol: 'v2',
      bootstrap: v2Bootstrap({
        conversation: { ...v2Summary, queueRevision: 7, v2LastSeq: 20 },
        queueRevision: 7,
        v2ThroughSeq: 20,
      }),
    });

    await expect(
      useChatStore.getState().enqueueInput(ref, { behavior: 'followUp', text: 'retry me' }),
    ).rejects.toBeDefined();

    expect(mockApi.chatUnsubscribeV2).not.toHaveBeenCalled();
    expect(mockApi.chatSubscribeV2).toHaveBeenNthCalledWith(2, ref, 20);
    expect(useChatStore.getState().v2Projections[key]).toMatchObject({
      queueRevision: 7,
      lastAppliedV2Seq: 20,
    });
  });

  it('coalesces simultaneous sequence gaps into one guarded bootstrap refresh', async () => {
    mockApi.chatGetInitialState.mockResolvedValueOnce({
      protocol: 'v2',
      bootstrap: v2Bootstrap(),
    });
    await useChatStore.getState().openConversation(ref, 'main-chat');
    mockApi.chatGetInitialState.mockClear();
    const refresh = deferred<Awaited<ReturnType<typeof window.api.chatGetInitialState>>>();
    mockApi.chatGetInitialState.mockReturnValue(refresh.promise);
    const gap = {
      type: 'event' as const,
      id: 'run-1',
      conversationId: ref.id,
      runId: 'run-1',
      segmentTurnId: 'run-1:segment',
      v2Seq: 15,
      event: { type: 'text_delta', text: 'gap' },
    };

    const first = useChatStore.getState().applyV2Frame(gap);
    const second = useChatStore.getState().applyV2Frame(gap);
    expect(mockApi.chatGetInitialState).toHaveBeenCalledOnce();
    refresh.resolve({
      protocol: 'v2',
      bootstrap: v2Bootstrap({
        conversation: { ...v2Summary, v2LastSeq: 15 },
        v2ThroughSeq: 15,
      }),
    });
    await Promise.all([first, second]);

    expect(mockApi.chatGetInitialState).toHaveBeenCalledOnce();
    expect(mockApi.chatSubscribeV2).toHaveBeenCalledTimes(2);
    expect(mockApi.chatUnsubscribeV2).not.toHaveBeenCalled();
    expect(useChatStore.getState().v2Projections[key].lastAppliedV2Seq).toBe(15);
  });

  it('starts a new gap refresh after close and reopen while the old refresh is pending', async () => {
    const oldRefresh = deferred<Awaited<ReturnType<typeof window.api.chatGetInitialState>>>();
    const newRefresh = deferred<Awaited<ReturnType<typeof window.api.chatGetInitialState>>>();
    mockApi.chatGetInitialState
      .mockResolvedValueOnce({ protocol: 'v2', bootstrap: v2Bootstrap() })
      .mockReturnValueOnce(oldRefresh.promise)
      .mockResolvedValueOnce({
        protocol: 'v2',
        bootstrap: v2Bootstrap({
          conversation: { ...v2Summary, v2LastSeq: 20 },
          v2ThroughSeq: 20,
        }),
      })
      .mockReturnValueOnce(newRefresh.promise);
    await useChatStore.getState().openConversation(ref, 'main-chat');

    const oldGap = useChatStore.getState().applyV2Frame({
      type: 'event',
      id: 'run-1',
      conversationId: ref.id,
      runId: 'run-1',
      segmentTurnId: 'run-1:segment',
      v2Seq: 14,
      event: { type: 'text_delta', text: 'old gap' },
    });
    await vi.waitFor(() => expect(mockApi.chatGetInitialState).toHaveBeenCalledTimes(2));
    await useChatStore.getState().closeConversation(ref, 'main-chat');
    await useChatStore.getState().openConversation(ref, 'main-chat');

    const newGap = useChatStore.getState().applyV2Frame({
      type: 'event',
      id: 'run-1',
      conversationId: ref.id,
      runId: 'run-1',
      segmentTurnId: 'run-1:segment',
      v2Seq: 22,
      event: { type: 'text_delta', text: 'new gap' },
    });
    const refreshCalls = mockApi.chatGetInitialState.mock.calls.length;
    newRefresh.resolve({
      protocol: 'v2',
      bootstrap: v2Bootstrap({
        conversation: { ...v2Summary, v2LastSeq: 22 },
        v2ThroughSeq: 22,
      }),
    });
    oldRefresh.resolve({
      protocol: 'v2',
      bootstrap: v2Bootstrap({
        conversation: { ...v2Summary, v2LastSeq: 14 },
        v2ThroughSeq: 14,
      }),
    });
    await Promise.all([oldGap, newGap]);

    expect(refreshCalls).toBe(4);
    expect(useChatStore.getState().v2Projections[key].lastAppliedV2Seq).toBe(22);
    expect(mockApi.chatSubscribeV2).toHaveBeenCalledTimes(3);
  });

  it('makes a remote-accepted refresh inert after the final owner leaves', async () => {
    mockApi.chatGetInitialState.mockResolvedValueOnce({
      protocol: 'v2',
      bootstrap: v2Bootstrap(),
    });
    await useChatStore.getState().openConversation(ref, 'main-chat');
    mockApi.chatGetInitialState.mockClear();
    const refresh = deferred<Awaited<ReturnType<typeof window.api.chatGetInitialState>>>();
    mockApi.chatGetInitialState.mockReturnValue(refresh.promise);

    const applying = useChatStore.getState().applyV2Frame(v2Accepted('remote-run', 13));
    await vi.waitFor(() => expect(mockApi.chatGetInitialState).toHaveBeenCalledOnce());
    await useChatStore.getState().closeConversation(ref, 'main-chat');
    refresh.resolve({
      protocol: 'v2',
      bootstrap: v2Bootstrap({
        conversation: { ...v2Summary, activeTurnId: 'stale-refresh', v2LastSeq: 13 },
        v2ThroughSeq: 13,
      }),
    });
    await applying;

    expect(useChatStore.getState().v2Projections[key].conversation.activeTurnId).toBe('remote-run');
    expect(mockApi.chatSubscribeV2).toHaveBeenCalledOnce();
  });
});
