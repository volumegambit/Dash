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
  SubagentListEntry,
} from '@dash/mobile-contract';
import { create } from 'zustand';
import type {
  ChatConnectionIssue,
  ConversationInvalidation,
  McAgentEvent,
} from '../../../shared/ipc.js';
import { isTerminalSubagentStatus, rowStatusOf } from '../routes/chat.swarm.js';
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

/**
 * Everything one sub-agent card owns that is NOT a fact about the child: does
 * it show its body, what has been fetched into it, what the user has half-typed
 * into its composer, whether a send is in flight, and the last refusal the
 * gateway gave it.
 *
 * It lives in the store rather than in the card because the card is remounted
 * by things that have nothing to do with it: the streaming bubble and the
 * finalized bubble are different elements, so a `useState` expansion snaps shut
 * at exactly the moment the child's report arrives.
 */
export interface SubagentUiState {
  expanded: boolean;
  /**
   * §8.2's parallel group, collapsed as a unit. Held against the FIRST child
   * of the cluster, which is the only member whose identity the cluster has.
   *
   * In the store rather than in the component for the same reason `expanded`
   * is: a live turn's bubble and the persisted message that replaces it are
   * different elements, so component state would snap the group back open at
   * exactly the moment the turn ends.
   */
  groupCollapsed: boolean;
  transcript?: ConversationMessage[];
  /** True once a fetch has landed, so a re-open does not re-walk the history. */
  transcriptLoaded: boolean;
  draft: string;
  /** The gateway's own sentence for a refused stop/resume, or a fetch failure. */
  notice: string | null;
  sending: boolean;
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
  connectionIssue: ChatConnectionIssue | null;
  /**
   * The selected conversation's DEPTH-0 children, straight from
   * `GET /conversations/:id/subagents`. The FACTS a card and a panel row read.
   *
   * Kept in its own record, separate from {@link ChatState.subagentUi}, so that
   * a list read can REPLACE it wholesale without a merge: there is no card
   * state inside it to lose. The web port had the two merged and needed a
   * "preserve `expanded` on refresh" rule; this shape has nothing to preserve.
   */
  subagents: SubagentListEntry[];
  /** Per-card UI, keyed by sub-agent id. Cleared with the conversation. */
  subagentUi: Record<string, SubagentUiState>;

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
  handleConnectionIssue(issue: ChatConnectionIssue): void;
  invalidateConversation(event: ConversationInvalidation): Promise<void>;
  /** Re-read the selected conversation's children. Safe to call at any time. */
  refreshSubagents(): Promise<void>;
  toggleSubagent(subagentId: string): void;
  /** Collapse or expand §8.2's parallel group anchored on this child. */
  toggleSubagentGroup(anchorSubagentId: string): void;
  /** Fetch a child's transcript. Once per card unless `force`. */
  loadSubagentTranscript(subagentId: string, force?: boolean): Promise<void>;
  setSubagentDraft(subagentId: string, draft: string): void;
  dismissSubagentNotice(subagentId: string): void;
  stopSubagent(subagentId: string): Promise<void>;
  /** True when the gateway accepted the message. */
  resumeSubagent(subagentId: string, message: string): Promise<boolean>;
}

/**
 * The frames that change WHICH children a conversation has, or what state one
 * of them is in — the trigger for a list re-read. Both families, because the
 * legacy mirrors are still on the wire until task D8.
 */
const SUBAGENT_LIST_TRIGGERS = new Set<string>([
  'subagent_started',
  'subagent_finished',
  'worker_spawned',
  'worker_done',
]);

/** The selected conversation's key, or `null` when nothing is selected. */
function keyOrNull(ref: ConversationRef | null): ConversationKey | null {
  return ref ? conversationKey(ref) : null;
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

  // --- Sub-agents (design §7.7, §8.1, §8.4) ---
  //
  // Two counters, both guarding the SAME read. `subagentReadSeq` numbers every
  // read that starts; `appliedSubagentSeq` remembers the newest one that has
  // written. A response older than the cursor is dropped, so whichever order
  // two overlapping reads come back in, the newest wins.
  let subagentReadSeq = 0;
  let appliedSubagentSeq = 0;

  const BLANK_SUBAGENT_UI: SubagentUiState = {
    expanded: false,
    groupCollapsed: false,
    transcriptLoaded: false,
    draft: '',
    notice: null,
    sending: false,
  };

  const patchSubagentUi = (subagentId: string, patch: Partial<SubagentUiState>): void => {
    set((state) => ({
      subagentUi: {
        ...state.subagentUi,
        [subagentId]: { ...BLANK_SUBAGENT_UI, ...state.subagentUi[subagentId], ...patch },
      },
    }));
  };

  const reasonOf = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

  /**
   * Forget every child of the conversation being left, and make any read still
   * in flight for it inert — bumping BOTH counters means the pending response's
   * sequence number is already behind the cursor when it lands.
   */
  const clearSubagents = (): void => {
    appliedSubagentSeq = ++subagentReadSeq;
    set({ subagents: [], subagentUi: {} });
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
    connectionIssue: null,
    subagents: [],
    subagentUi: {},

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
          connectionIssue: null,
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
      // The children belong to ONE conversation, and so does every open card
      // body. Carrying either across a switch would draw the previous
      // conversation's sub-agents over this one's transcript. The cost, stated:
      // switching tabs and back collapses every card and drops its draft.
      clearSubagents();
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
      // Unconditional, and the ONLY trigger that fires for a conversation
      // nobody is streaming: a reopened conversation with a background child
      // has no live turn, so no frame will ever arrive to ask for this.
      await get().refreshSubagents();
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
      const before = get().selectedConversationRef;
      set((state) => {
        const openTabKeys = state.openTabKeys.filter((tab) => tab !== key);
        return {
          openTabKeys,
          selectedConversationRef: selectedAfterRemoval(state, key, openTabKeys),
        };
      });
      // Closing the SELECTED tab switches conversation without going through
      // `selectConversation`, and `subagents` / `subagentUi` describe ONE
      // conversation: left alone, the panel draws the closed conversation's
      // children under the new tab's transcript. Clearing alone would only
      // blank them — the poll is armed by the list itself, so nothing would
      // ever fill it again — so this does what a selection does and re-reads.
      // Closing any other tab leaves the selection, and the children, alone.
      const after = get().selectedConversationRef;
      if (keyOrNull(before) === keyOrNull(after)) return;
      clearSubagents();
      void get().refreshSubagents();
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
          messages: {
            ...state.messages,
            [key]: (state.messages[key] ?? []).filter(
              (message) => message.id !== `optimistic:${turnId}`,
            ),
          },
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
      // A child appearing or finishing changes the conversation's children;
      // read the list again. Deliberately NOT on `subagent_progress`: a busy
      // child reports progress far faster than a list read is worth, and the
      // status set it would report has not changed. Gated on the SELECTED
      // conversation, so a grandchild starting inside a subscribed child does
      // not trigger a read the list could not answer anyway.
      if (frame.type === 'event' && SUBAGENT_LIST_TRIGGERS.has(frame.event.type)) {
        const selected = get().selectedConversationRef;
        if (selected && selected.id === frame.conversationId) {
          void get().refreshSubagents();
        }
      }
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

    handleConnectionIssue(issue) {
      set({ connectionIssue: issue, conversationError: issue.message });
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

    // --- Sub-agents ---

    async refreshSubagents() {
      const ref = get().selectedConversationRef;
      // Gateway conversations only. An "On this Mac" conversation has no
      // gateway row, so asking for its children is a request that can only
      // fail — once per selection, silently, forever.
      if (!ref || ref.origin !== 'gateway') {
        set({ subagents: [] });
        return;
      }
      const seq = ++subagentReadSeq;
      let list: SubagentListEntry[];
      try {
        list = await window.api.subagentsList(ref.id);
      } catch (error) {
        // A conversation with no children is a 404 on some paths and an empty
        // list on others; either way this read is a background refresh and must
        // not put a banner over the transcript. Card-level failures (stop,
        // resume, transcript) DO surface, on the card that caused them.
        handleApiError(error);
        return;
      }
      // Guard 1: the user may have left. `selectConversation` also bumps the
      // cursor, so this is belt and braces — it is the one that still holds
      // when the switch happens without going through the store.
      const current = get().selectedConversationRef;
      if (!current || current.id !== ref.id) return;
      // Guard 2: a read that started earlier than the newest APPLIED one is
      // stale whatever order it resolved in.
      if (seq <= appliedSubagentSeq) return;
      appliedSubagentSeq = seq;
      set({ subagents: list });
    },

    toggleSubagent(subagentId) {
      const open = get().subagentUi[subagentId]?.expanded === true;
      patchSubagentUi(subagentId, { expanded: !open });
    },

    toggleSubagentGroup(anchorSubagentId) {
      const collapsed = get().subagentUi[anchorSubagentId]?.groupCollapsed === true;
      patchSubagentUi(anchorSubagentId, { groupCollapsed: !collapsed });
    },

    async loadSubagentTranscript(subagentId, force = false) {
      if (!force && get().subagentUi[subagentId]?.transcriptLoaded) return;
      try {
        const page = await window.api.conversationMessages(subagentId);
        // Sorted here rather than trusting the page order. The route does
        // return `ordinal ASC` today, but a card that renders `page.items`
        // verbatim depends on that silently — and the parent transcript does
        // not, since every page it reads goes through `mergeCanonicalMessages`.
        const transcript = [...page.items].sort((a, b) => a.ordinal - b.ordinal);
        patchSubagentUi(subagentId, { transcript, transcriptLoaded: true });
      } catch (error) {
        patchSubagentUi(subagentId, { notice: reasonOf(error) });
      }
    },

    setSubagentDraft(subagentId, draft) {
      patchSubagentUi(subagentId, { draft });
    },

    dismissSubagentNotice(subagentId) {
      patchSubagentUi(subagentId, { notice: null });
    },

    async stopSubagent(subagentId) {
      patchSubagentUi(subagentId, { notice: null });
      try {
        const result = await window.api.subagentStop(subagentId);
        if (!result.ok) patchSubagentUi(subagentId, { notice: result.reason });
      } catch (error) {
        patchSubagentUi(subagentId, { notice: reasonOf(error) });
      }
      // Unconditional: a refused stop is usually a race the row lost, and the
      // re-read is what tells the user what actually happened to the child.
      await get().refreshSubagents();
    },

    async resumeSubagent(subagentId, message) {
      patchSubagentUi(subagentId, { sending: true, notice: null });
      // Sent so the server CAN correlate the turn this becomes; Mission
      // Control cannot observe the echo, because the `accepted` frame carrying
      // it rides the CHILD conversation's stream and this app holds no
      // subscription to it. Omitting it would forfeit a correlation that
      // cannot be claimed after the fact.
      const requestId = crypto.randomUUID();
      let accepted = false;
      try {
        const result = await window.api.subagentResume(subagentId, message, requestId);
        if (result.ok) accepted = true;
        else patchSubagentUi(subagentId, { sending: false, notice: result.reason });
      } catch (error) {
        patchSubagentUi(subagentId, { sending: false, notice: reasonOf(error) });
      }
      // The draft survives a refusal — the user's sentence is still worth
      // something once they know why it bounced.
      if (!accepted) return false;
      patchSubagentUi(subagentId, { sending: false, draft: '' });
      // Both re-reads exist because no child event reaches the parent outside a
      // live parent turn: without them the row and its body describe the run
      // BEFORE the resume for as long as the new one lasts.
      await get().refreshSubagents();
      if (get().subagentUi[subagentId]?.transcriptLoaded) {
        await get().loadSubagentTranscript(subagentId, true);
      }
      return true;
    },
  };
});

/**
 * Cadence of the live re-read of the selected conversation's children.
 *
 * INTERIM. This poll is the whole of Mission Control's liveness for a child
 * outside a live parent turn: `swarm:run-changed` is throttled to one per run
 * per second with no trailing emit, and no `subagent_*` frame reaches this
 * client unless a parent turn is streaming. Task D7b adds design §8.3's
 * conversation-scoped subscription, at which point this becomes a backstop
 * rather than the mechanism. Do not grow it in the meantime.
 *
 * It lives here, next to the children it re-reads, rather than in `SwarmPanel`
 * where it started: mounted in the panel it ran only while the panel was open,
 * so an expanded card of a background child in a reopened conversation — no
 * live turn, no frames, panel closed — had no refresh trigger at all, and its
 * spinner and elapsed counter ticked upward forever.
 */
const LIVE_SUBAGENT_POLL_MS = 20_000;

let livePollTimer: ReturnType<typeof setInterval> | null = null;

// Driven off the children themselves, so every writer of `subagents` is
// covered — the selection read, the frame trigger, a stop, a resume, the poll
// itself, and `clearSubagents` — without any of them having to remember.
useChatStore.subscribe((state, previous) => {
  if (state.subagents === previous.subagents) return;
  const live = state.subagents.some(
    (entry) => !isTerminalSubagentStatus(rowStatusOf(entry.status)),
  );
  if (!live) {
    if (livePollTimer !== null) {
      clearInterval(livePollTimer);
      livePollTimer = null;
    }
    return;
  }
  if (livePollTimer !== null) return;
  livePollTimer = setInterval(() => {
    void useChatStore.getState().refreshSubagents();
  }, LIVE_SUBAGENT_POLL_MS);
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
  window.api.onChatConnectionError((issue) => {
    useChatStore.getState().handleConnectionIssue(issue);
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
