import type {
  ConversationAuthorityMode,
  ConversationOrigin,
  ConversationRef,
  McConversationView,
} from '@dash/mc';
import type {
  ConversationMessage,
  ConversationMessagePage,
  MobileApiError,
  MobileImage,
  MobileWsServerFrame,
} from '@dash/mobile-contract';
import { create } from 'zustand';
import type { ConversationInvalidation, McAgentEvent } from '../../../shared/ipc.js';
import {
  applySequencedFrame,
  mergeCanonicalMessages,
  replaceAcceptedOptimisticMessage,
} from './chat-sync.js';

export type ConversationKey = `${ConversationOrigin}:${string}`;

export function conversationKey(ref: ConversationRef): ConversationKey {
  return `${ref.origin}:${ref.id}`;
}

export function conversationRefFromKey(key: ConversationKey): ConversationRef {
  const separator = key.indexOf(':');
  return {
    origin: key.slice(0, separator) as ConversationOrigin,
    id: key.slice(separator + 1),
  };
}

function refFor(conversation: McConversationView): ConversationRef {
  return { id: conversation.id, origin: conversation.origin };
}

function sameConversation(conversation: McConversationView, ref: ConversationRef): boolean {
  return conversation.id === ref.id && conversation.origin === ref.origin;
}

export function sortConversations(items: McConversationView[]): McConversationView[] {
  return [...items].sort(
    (a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id),
  );
}

function mergeConversations(
  current: McConversationView[],
  incoming: McConversationView[],
): McConversationView[] {
  const byKey = new Map(
    current.map((conversation) => [conversationKey(refFor(conversation)), conversation]),
  );
  for (const conversation of incoming) {
    const key = conversationKey(refFor(conversation));
    const existing = byKey.get(key);
    if (!existing || conversation.revision >= existing.revision) byKey.set(key, conversation);
  }
  return sortConversations([...byKey.values()]);
}

function reconcileFirstPage(
  current: McConversationView[],
  incoming: McConversationView[],
): McConversationView[] {
  const currentByKey = new Map(
    current.map((conversation) => [conversationKey(refFor(conversation)), conversation]),
  );
  return sortConversations(
    incoming.map((conversation) => {
      const existing = currentByKey.get(conversationKey(refFor(conversation)));
      return existing && existing.revision > conversation.revision ? existing : conversation;
    }),
  );
}

function withoutKey<T>(
  record: Record<ConversationKey, T>,
  key: ConversationKey,
): Record<ConversationKey, T> {
  const { [key]: _removed, ...rest } = record;
  return rest as Record<ConversationKey, T>;
}

function mobileError(error: unknown): MobileApiError | null {
  if (!error || typeof error !== 'object') return null;
  const candidate =
    'apiError' in error && error.apiError && typeof error.apiError === 'object'
      ? error.apiError
      : error;
  return 'code' in candidate && typeof candidate.code === 'string'
    ? (candidate as MobileApiError)
    : null;
}

export function isRevisionConflict(error: unknown): boolean {
  return mobileError(error)?.code === 'revision_conflict';
}

export interface ChatState {
  conversations: McConversationView[];
  nextConversationCursor: string | null;
  conversationAuthority: ConversationAuthorityMode;
  gatewayOnline: boolean;
  selectedConversationRef: ConversationRef | null;
  openTabKeys: ConversationKey[];
  messages: Record<ConversationKey, ConversationMessage[]>;
  messageCursor: Record<ConversationKey, string | null>;
  throughSeq: Record<ConversationKey, number>;
  streamingFrames: Record<ConversationKey, MobileWsServerFrame[]>;
  lastSeq: Record<ConversationKey, number>;
  localTurnIds: Record<ConversationKey, string | undefined>;
  sending: Record<ConversationKey, boolean>;
  unreadConversations: Set<ConversationKey>;
  conversationError: string | null;

  loadConversations(): Promise<void>;
  loadMoreConversations(): Promise<void>;
  ensureConversation(ref: ConversationRef): Promise<McConversationView | null>;
  ensureMessages(ref: ConversationRef): Promise<void>;
  loadOlderMessages(ref: ConversationRef): Promise<void>;
  selectConversation(ref: ConversationRef): Promise<void>;
  openTab(ref: ConversationRef): void;
  closeTab(key: ConversationKey): void;
  createConversation(agentId: string): Promise<McConversationView>;
  renameConversation(ref: ConversationRef, title: string): Promise<void>;
  deleteConversation(ref: ConversationRef): Promise<void>;
  sendMessage(ref: ConversationRef, text: string, images?: MobileImage[]): Promise<void>;
  cancelMessage(ref: ConversationRef): void;
  answerQuestion(ref: ConversationRef, questionId: string, answer: string): void;
  applyFrame(frame: MobileWsServerFrame): Promise<void>;
  invalidateConversation(event: ConversationInvalidation): Promise<void>;
}

function selectedAfterRemoval(
  state: ChatState,
  removedKey: ConversationKey,
  remainingTabs: ConversationKey[],
): ConversationRef | null {
  if (
    !state.selectedConversationRef ||
    conversationKey(state.selectedConversationRef) !== removedKey
  ) {
    return state.selectedConversationRef;
  }
  const oldIndex = state.openTabKeys.indexOf(removedKey);
  const next = remainingTabs[Math.min(oldIndex, remainingTabs.length - 1)];
  return next ? conversationRefFromKey(next) : null;
}

export const useChatStore = create<ChatState>((set, get) => {
  let firstPageRequest = 0;
  let firstPagePending = false;

  const upsertConversation = (conversation: McConversationView): void => {
    set((state) => ({
      conversations: mergeConversations(state.conversations, [conversation]),
    }));
  };

  const markOffline = (message = 'Gateway offline — cached conversations are read-only'): void => {
    set((state) => ({
      gatewayOnline: false,
      conversations: state.conversations.map((conversation) =>
        conversation.origin === 'gateway'
          ? { ...conversation, offline: true, readOnly: true }
          : conversation,
      ),
      conversationError: message,
    }));
  };

  const handleApiError = (error: unknown): void => {
    const apiError = mobileError(error);
    if (apiError?.code === 'gateway_offline') markOffline(apiError.error);
  };

  const purgeConversation = (ref: ConversationRef): void => {
    const key = conversationKey(ref);
    set((state) => {
      const openTabKeys = state.openTabKeys.filter((tab) => tab !== key);
      const unread = new Set(state.unreadConversations);
      unread.delete(key);
      return {
        conversations: state.conversations.filter(
          (conversation) => !sameConversation(conversation, ref),
        ),
        selectedConversationRef: selectedAfterRemoval(state, key, openTabKeys),
        openTabKeys,
        messages: withoutKey(state.messages, key),
        messageCursor: withoutKey(state.messageCursor, key),
        throughSeq: withoutKey(state.throughSeq, key),
        streamingFrames: withoutKey(state.streamingFrames, key),
        lastSeq: withoutKey(state.lastSeq, key),
        localTurnIds: withoutKey(state.localTurnIds, key),
        sending: withoutKey(state.sending, key),
        unreadConversations: unread,
      };
    });
  };

  const exactConversation = (ref: ConversationRef): McConversationView | undefined =>
    get().conversations.find((conversation) => sameConversation(conversation, ref));

  const assertMutable = (ref: ConversationRef): McConversationView => {
    const conversation = exactConversation(ref);
    if (!conversation) throw new Error('Conversation not found');
    if (
      !get().gatewayOnline ||
      conversation.offline ||
      conversation.readOnly ||
      conversation.status === 'archived' ||
      conversation.status === 'deleted' ||
      conversation.status === 'running' ||
      conversation.activeTurnId !== null
    ) {
      throw new Error('This conversation is read-only');
    }
    return conversation;
  };

  const storeMessagePage = (
    ref: ConversationRef,
    page: ConversationMessagePage,
    mode: 'replace' | 'merge',
  ): void => {
    const key = conversationKey(ref);
    set((state) => ({
      messages: {
        ...state.messages,
        [key]:
          mode === 'replace'
            ? mergeCanonicalMessages([], page.items)
            : mergeCanonicalMessages(state.messages[key] ?? [], page.items),
      },
      messageCursor: { ...state.messageCursor, [key]: page.nextCursor },
      throughSeq: { ...state.throughSeq, [key]: page.throughSeq },
      lastSeq: {
        ...state.lastSeq,
        [key]: Math.max(state.lastSeq[key] ?? 0, page.throughSeq),
      },
    }));
  };

  const refreshTerminal = async (ref: ConversationRef): Promise<void> => {
    const key = conversationKey(ref);
    try {
      const [page, conversation] = await Promise.all([
        window.api.chatGetMessages(ref, undefined),
        window.api.chatGetConversation(ref),
      ]);
      if (!conversation || conversation.status === 'deleted') {
        purgeConversation(ref);
        set({ conversationError: 'Conversation not found' });
        return;
      }
      set((state) => {
        const unread =
          state.selectedConversationRef && conversationKey(state.selectedConversationRef) === key
            ? state.unreadConversations
            : new Set([...state.unreadConversations, key]);
        return {
          conversations: mergeConversations(state.conversations, [conversation]),
          messages: {
            ...state.messages,
            [key]: mergeCanonicalMessages(state.messages[key] ?? [], page.items),
          },
          messageCursor: { ...state.messageCursor, [key]: page.nextCursor },
          throughSeq: { ...state.throughSeq, [key]: page.throughSeq },
          lastSeq: {
            ...state.lastSeq,
            [key]: Math.max(page.throughSeq, conversation.lastSeq),
          },
          streamingFrames: { ...state.streamingFrames, [key]: [] },
          localTurnIds: { ...state.localTurnIds, [key]: undefined },
          sending: { ...state.sending, [key]: false },
          unreadConversations: unread,
        };
      });
    } catch (error) {
      handleApiError(error);
      set((state) => ({
        localTurnIds: { ...state.localTurnIds, [key]: undefined },
        sending: { ...state.sending, [key]: false },
      }));
      throw error;
    }
  };

  return {
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

    async loadConversations() {
      const request = ++firstPageRequest;
      firstPagePending = true;
      try {
        const result = await window.api.chatListConversations();
        if (request !== firstPageRequest) return;
        set((state) => ({
          conversations: reconcileFirstPage(state.conversations, result.items),
          nextConversationCursor: result.nextCursor,
          conversationAuthority: result.authority,
          gatewayOnline: result.gatewayOnline,
          conversationError: null,
        }));
        firstPagePending = false;
      } catch (error) {
        if (request !== firstPageRequest) return;
        firstPagePending = false;
        handleApiError(error);
        throw error;
      }
    },

    async loadMoreConversations() {
      const cursor = get().nextConversationCursor;
      if (!cursor || firstPagePending) return;
      const firstPageAtStart = firstPageRequest;
      try {
        const result = await window.api.chatListConversations(cursor);
        if (firstPagePending || firstPageAtStart !== firstPageRequest) return;
        set((state) => ({
          conversations: mergeConversations(state.conversations, result.items),
          nextConversationCursor: result.nextCursor,
          conversationAuthority: result.authority,
          gatewayOnline: result.gatewayOnline,
        }));
      } catch (error) {
        if (firstPagePending || firstPageAtStart !== firstPageRequest) return;
        handleApiError(error);
        throw error;
      }
    },

    async ensureConversation(ref) {
      const existing = exactConversation(ref);
      if (existing && existing.status !== 'deleted') return existing;
      if (existing?.status === 'deleted') purgeConversation(ref);
      try {
        const conversation = await window.api.chatGetConversation(ref);
        if (!conversation || conversation.status === 'deleted') {
          purgeConversation(ref);
          return null;
        }
        upsertConversation(conversation);
        return conversation;
      } catch (error) {
        if (mobileError(error)?.code === 'not_found') {
          purgeConversation(ref);
          set({ conversationError: 'Conversation not found' });
          return null;
        }
        handleApiError(error);
        throw error;
      }
    },

    async ensureMessages(ref) {
      const key = conversationKey(ref);
      if (Object.hasOwn(get().messages, key)) return;
      try {
        const page = await window.api.chatGetMessages(ref, undefined);
        storeMessagePage(ref, page, 'replace');
      } catch (error) {
        handleApiError(error);
        throw error;
      }
    },

    async loadOlderMessages(ref) {
      const key = conversationKey(ref);
      const cursor = get().messageCursor[key];
      if (!cursor) return;
      try {
        const page = await window.api.chatGetMessages(ref, cursor);
        storeMessagePage(ref, page, 'merge');
      } catch (error) {
        handleApiError(error);
        throw error;
      }
    },

    async selectConversation(ref) {
      const conversation = await get().ensureConversation(ref);
      if (!conversation) {
        set({ conversationError: 'Conversation not found' });
        return;
      }
      const key = conversationKey(ref);
      const unread = new Set(get().unreadConversations);
      unread.delete(key);
      set((state) => ({
        selectedConversationRef: ref,
        openTabKeys: state.openTabKeys.includes(key)
          ? state.openTabKeys
          : [...state.openTabKeys, key],
        unreadConversations: unread,
        conversationError: null,
      }));
      await get().ensureMessages(ref);
    },

    openTab(ref) {
      const key = conversationKey(ref);
      set((state) => ({
        openTabKeys: state.openTabKeys.includes(key)
          ? state.openTabKeys
          : [...state.openTabKeys, key],
      }));
    },

    closeTab(key) {
      set((state) => {
        const openTabKeys = state.openTabKeys.filter((tab) => tab !== key);
        return {
          openTabKeys,
          selectedConversationRef: selectedAfterRemoval(state, key, openTabKeys),
        };
      });
    },

    async createConversation(agentId) {
      if (!get().gatewayOnline || get().conversationAuthority === 'unresolved') {
        throw new Error('Gateway offline — cached conversations are read-only');
      }
      const requestId = crypto.randomUUID();
      const conversation = await window.api.chatCreateConversation(agentId, requestId);
      const ref = refFor(conversation);
      const key = conversationKey(ref);
      set((state) => ({
        conversations: mergeConversations(state.conversations, [conversation]),
        selectedConversationRef: ref,
        openTabKeys: state.openTabKeys.includes(key)
          ? state.openTabKeys
          : [...state.openTabKeys, key],
        messages: { ...state.messages, [key]: [] },
        messageCursor: { ...state.messageCursor, [key]: null },
        throughSeq: { ...state.throughSeq, [key]: 0 },
        conversationError: null,
      }));
      return conversation;
    },

    async renameConversation(ref, title) {
      const conversation = assertMutable(ref);
      try {
        const updated = await window.api.chatRenameConversation(ref, conversation.revision, title);
        upsertConversation(updated);
      } catch (error) {
        const apiError = mobileError(error);
        if (apiError?.code === 'revision_conflict') {
          const current = apiError.details?.current;
          if (current && typeof current === 'object') {
            upsertConversation({ ...conversation, ...current });
          }
        }
        handleApiError(error);
        throw error;
      }
    },

    async deleteConversation(ref) {
      const conversation = assertMutable(ref);
      try {
        await window.api.chatDeleteConversation(ref, conversation.revision);
        purgeConversation(ref);
      } catch (error) {
        const apiError = mobileError(error);
        if (apiError?.code === 'revision_conflict') {
          const current = apiError.details?.current;
          if (current && typeof current === 'object') {
            upsertConversation({ ...conversation, ...current });
          }
        }
        handleApiError(error);
        throw error;
      }
    },

    async sendMessage(ref, text, images) {
      const conversation = assertMutable(ref);
      const key = conversationKey(ref);
      const turnId = crypto.randomUUID();
      const now = new Date().toISOString();
      const optimistic: ConversationMessage = {
        id: `optimistic:${turnId}`,
        conversationId: ref.id,
        turnId,
        ordinal: Number.MAX_SAFE_INTEGER,
        role: 'user',
        status: 'accepted',
        content: { type: 'user', text, ...(images?.length ? { images } : {}) },
        createdAt: now,
        updatedAt: now,
      };
      set((state) => ({
        messages: {
          ...state.messages,
          [key]: [...(state.messages[key] ?? []), optimistic],
        },
        streamingFrames: { ...state.streamingFrames, [key]: [] },
        localTurnIds: { ...state.localTurnIds, [key]: turnId },
        sending: { ...state.sending, [key]: true },
        lastSeq: { ...state.lastSeq, [key]: state.lastSeq[key] ?? conversation.lastSeq },
      }));
      try {
        const accepted = await window.api.chatSend(ref, turnId, text, images);
        if (accepted) await get().applyFrame(accepted);
      } catch (error) {
        handleApiError(error);
        set((state) => ({
          localTurnIds: { ...state.localTurnIds, [key]: undefined },
          sending: { ...state.sending, [key]: false },
        }));
        throw error;
      }
    },

    cancelMessage(ref) {
      const key = conversationKey(ref);
      const conversation = exactConversation(ref);
      const turnId = conversation?.activeTurnId ?? get().localTurnIds[key];
      if (!conversation || !turnId) return;
      window.api.chatCancel(ref, turnId);
      set((state) => ({ sending: { ...state.sending, [key]: false } }));
    },

    answerQuestion(ref, questionId, answer) {
      const key = conversationKey(ref);
      const conversation = exactConversation(ref);
      if (!conversation || conversation.offline || conversation.readOnly || !get().gatewayOnline) {
        throw new Error('This conversation is read-only');
      }
      const turnId = conversation.activeTurnId ?? get().localTurnIds[key];
      if (!turnId) throw new Error('Conversation does not have an active turn');
      window.api.chatAnswerQuestion(ref, turnId, questionId, answer);
    },

    async applyFrame(frame) {
      if (!frame.conversationId) return;
      const ref = { id: frame.conversationId, origin: 'gateway' as const };
      const key = conversationKey(ref);
      const current = {
        lastSeq: get().lastSeq[key] ?? 0,
        frames: get().streamingFrames[key] ?? [],
      };
      const applied = applySequencedFrame(current, frame);
      if (applied.gapAfter !== null) {
        await refreshTerminal(ref);
        return;
      }
      if (applied.state === current) return;

      if (frame.type === 'accepted') {
        set((state) => ({
          messages: {
            ...state.messages,
            [key]: replaceAcceptedOptimisticMessage(state.messages[key] ?? [], frame),
          },
          streamingFrames: { ...state.streamingFrames, [key]: applied.state.frames },
          lastSeq: { ...state.lastSeq, [key]: applied.state.lastSeq },
          conversations: state.conversations.map((conversation) =>
            sameConversation(conversation, ref)
              ? {
                  ...conversation,
                  revision: frame.revision,
                  activeTurnId: frame.id,
                  status: 'running',
                  lastSeq: frame.seq,
                }
              : conversation,
          ),
        }));
        return;
      }

      set((state) => ({
        streamingFrames: { ...state.streamingFrames, [key]: applied.state.frames },
        lastSeq: { ...state.lastSeq, [key]: applied.state.lastSeq },
        conversations: state.conversations.map((conversation) =>
          sameConversation(conversation, ref)
            ? {
                ...conversation,
                activeTurnId: conversation.activeTurnId ?? frame.id,
                status: 'running',
                lastSeq: applied.state.lastSeq,
              }
            : conversation,
        ),
      }));
      if (frame.type === 'done' || frame.type === 'error') await refreshTerminal(ref);
    },

    async invalidateConversation(event) {
      const ref = event.conversation;
      if (event.type === 'deleted') {
        purgeConversation(ref);
        return;
      }
      if (ref.origin === 'gateway' && ref.id === '*') {
        await get().loadConversations();
        return;
      }
      try {
        const conversation = await window.api.chatGetConversation(ref);
        if (!conversation || conversation.status === 'deleted') {
          purgeConversation(ref);
          return;
        }
        upsertConversation(conversation);
        if (conversation.activeTurnId) {
          const page = await window.api.chatGetMessages(ref, undefined);
          storeMessagePage(ref, page, 'merge');
        }
      } catch (error) {
        handleApiError(error);
        throw error;
      }
    },
  };
});

let initialized = false;

export function initChatListeners(): void {
  if (initialized) return;
  initialized = true;

  window.api.onChatFrame((frame) => {
    void useChatStore
      .getState()
      .applyFrame(frame)
      .catch(() => undefined);
  });
  window.api.onChatConversationInvalidated((event) => {
    void useChatStore
      .getState()
      .invalidateConversation(event)
      .catch(() => undefined);
  });
  window.api.onAgentEvent((conversationId, event: McAgentEvent) => {
    const state = useChatStore.getState();
    const ref = state.selectedConversationRef;
    if (
      state.conversationAuthority !== 'legacy' ||
      ref?.origin !== 'local' ||
      ref.id !== conversationId
    ) {
      return;
    }
    const key = conversationKey(ref);
    const turnId = state.localTurnIds[key] ?? `legacy:${conversationId}`;
    const frame: MobileWsServerFrame = {
      type: 'event',
      id: turnId,
      conversationId,
      event,
    };
    useChatStore.setState((current) => ({
      streamingFrames: {
        ...current.streamingFrames,
        [key]: [...(current.streamingFrames[key] ?? []), frame],
      },
    }));
  });
  window.api.onChatDone((conversationId) => {
    const state = useChatStore.getState();
    const ref = state.selectedConversationRef;
    if (
      state.conversationAuthority === 'legacy' &&
      ref?.origin === 'local' &&
      ref.id === conversationId
    ) {
      void Promise.all([
        window.api.chatGetMessages(ref, undefined),
        window.api.chatGetConversation(ref),
      ]).then(([page, conversation]) => {
        if (!conversation) return;
        const key = conversationKey(ref);
        useChatStore.setState((current) => ({
          conversations: mergeConversations(current.conversations, [conversation]),
          messages: {
            ...current.messages,
            [key]: mergeCanonicalMessages(current.messages[key] ?? [], page.items),
          },
          messageCursor: { ...current.messageCursor, [key]: page.nextCursor },
          throughSeq: { ...current.throughSeq, [key]: page.throughSeq },
          streamingFrames: { ...current.streamingFrames, [key]: [] },
          localTurnIds: { ...current.localTurnIds, [key]: undefined },
          sending: { ...current.sending, [key]: false },
        }));
      });
    }
  });
  window.api.onChatError((conversationId, error) => {
    const state = useChatStore.getState();
    const ref = state.selectedConversationRef;
    if (
      state.conversationAuthority !== 'legacy' ||
      ref?.origin !== 'local' ||
      ref.id !== conversationId
    ) {
      return;
    }
    const key = conversationKey(ref);
    const turnId = state.localTurnIds[key] ?? `legacy:${conversationId}`;
    const frame: MobileWsServerFrame = {
      type: 'error',
      id: turnId,
      conversationId,
      error,
    };
    useChatStore.setState((current) => ({
      streamingFrames: {
        ...current.streamingFrames,
        [key]: [...(current.streamingFrames[key] ?? []), frame],
      },
      localTurnIds: { ...current.localTurnIds, [key]: undefined },
      sending: { ...current.sending, [key]: false },
      conversationError: error,
    }));
  });
  window.api.onChatConversationRenamed((conversationId, title) => {
    if (useChatStore.getState().conversationAuthority !== 'legacy') return;
    useChatStore.setState((state) => ({
      conversations: state.conversations.map((conversation) =>
        conversation.origin === 'local' && conversation.id === conversationId
          ? { ...conversation, title }
          : conversation,
      ),
    }));
  });
}
