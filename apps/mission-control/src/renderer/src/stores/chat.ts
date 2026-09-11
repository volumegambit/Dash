import type {
  ConversationAuthorityMode,
  ConversationOrigin,
  ConversationRef,
  McConversationView,
} from '@dash/mc';
import type {
  ConversationMessage,
  ConversationMessagePage,
  MobileAgentEvent,
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
import { isTerminalSubagentStatus, rowStatusOf, subagentIdOf } from '../routes/chat.swarm.js';
import {
  applySequencedFrame,
  mergeCanonicalMessages,
  replaceAcceptedOptimisticMessage,
} from './chat-sync.js';

export type ConversationKey = `${ConversationOrigin}:${string}`;

export function conversationKey(ref: ConversationRef): ConversationKey {
  return `${ref.origin}:${ref.id}`;
}

/**
 * The hands-free `voice_*` server frames (Task B7) are keyed by voice session
 * id, not `conversationId`, and Mission Control has no voice UI yet. `applyFrame`
 * guards on this so a voice frame is ignored rather than mis-routed onto
 * whatever conversation happens to be selected.
 */
function isVoiceServerFrame(
  frame: MobileWsServerFrame,
): frame is Extract<MobileWsServerFrame, { type: `voice_${string}` }> {
  return frame.type.startsWith('voice_');
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
  /**
   * Take one hold on a child's live stream (design §7.6, §8.3): its frames
   * then reach {@link applyFrame} and land in this card's transcript.
   *
   * REFCOUNTED, because two surfaces can legitimately want the same child at
   * once — an expanded card and the open tasks panel — and because D1's fold
   * renders a row for a crash-reconciled child in TWO messages, so one row
   * collapsing must not cut the other one's stream off.
   */
  subscribeSubagent(subagentId: string): void;
  /** Release one hold; the last one out drops the watch, a microtask later. */
  unsubscribeSubagent(subagentId: string): void;
  /**
   * Whether this client holds a subscription on a child — i.e. whether an
   * `accepted` frame naming it will ever arrive here. `resumeSubagent` asks
   * before it shows the user's own sentence: an optimistic row with no echo
   * coming is a row nothing can reconcile.
   */
  isSubagentSubscribed(subagentId: string): boolean;
  /**
   * Main says the socket behind a hold is not open (design §7.6). The hold
   * STAYS — it is what keeps the subscribe/unsubscribe pairing 1:1 and what
   * main re-watches on a transport swap — but it stops counting as a live
   * stream, so no optimistic row is written for a message whose `accepted`
   * cannot arrive.
   */
  markSubagentWatchLost(subagentId: string): void;
  /**
   * A watched child's stream dropped and came back. Subscribing replays
   * NOTHING, so the only recovery for the gap is a re-read — and only for a
   * card that already has a transcript; one that never loaded reads on its
   * next expansion anyway.
   *
   * Also the ONLY thing that takes {@link markSubagentWatchLost} back.
   */
  restoreSubagentTranscript(subagentId: string): Promise<void>;
  setSubagentDraft(subagentId: string, draft: string): void;
  dismissSubagentNotice(subagentId: string): void;
  stopSubagent(subagentId: string): Promise<void>;
  /**
   * Send a message to a child. True when the gateway accepted it.
   *
   * `answering` is the CALLER's declaration that this message is a reply to
   * the question the card is showing. Only the question composer passes it,
   * and it exists because the two sources disagree for up to 20 s: see the
   * comment on the `parked` test inside.
   */
  resumeSubagent(
    subagentId: string,
    message: string,
    options?: { answering?: boolean },
  ): Promise<boolean>;
}

/**
 * The frames that change WHICH children a conversation has, or what state one
 * of them is in — the trigger for a list re-read. The canonical family alone:
 * D8 retired the `worker_*` mirrors, and a persisted pre-D8 one arrives only
 * on a REPLAY, where the list is read anyway.
 */
const SUBAGENT_LIST_TRIGGERS = new Set<string>(['subagent_started', 'subagent_finished']);

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
    const before = get().selectedConversationRef;
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
    // Deleting the conversation you are looking at switches the selection the
    // same way closing its tab does, through the same `selectedAfterRemoval`.
    followSelectionSwitch(before);
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

  /**
   * Children whose live stream this store holds, and how many surfaces hold
   * each. Closure state, not store state: it is wiring, and nothing renders it.
   */
  const childSubscriptions = new Map<
    string,
    {
      agentId: string;
      holds: number;
      /**
       * Whether the SOCKET behind this hold is open, as far as main has said.
       * Separate from `holds` because they answer different questions: `holds`
       * decides when to send `unsubscribe`, `live` decides whether an
       * `accepted` can ever arrive. Only the second gates optimism.
       */
      live: boolean;
    }
  >();
  /**
   * Every child this conversation has EVER held a subscription for. Wider than
   * `childSubscriptions` on purpose: the release is deferred and main closes
   * the socket later still, so frames keep arriving for a child with no holds
   * left. Without this they would fall through to the conversation path and be
   * written under the child's own key — where a `done` sends `refreshTerminal`
   * down `chatGetMessages`, which subscribes the resumable transport to a
   * SECOND socket on the same child (`main/chat-service.ts`'s `getMessages`).
   * Cleared by `clearSubagents`, which is the point at which the child stops
   * being any of this conversation's business.
   */
  const knownChildIds = new Set<string>();
  /**
   * Rows this store put into a child's transcript itself — a live assistant
   * message being streamed, or the user's own sentence before the server has
   * a copy. `loadSubagentTranscript` needs to tell them from the server's,
   * because they are the only ones a re-read must not simply replace.
   */
  const localChildRows = new Map<string, Set<string>>();
  /**
   * What a child's own LIVE stream last said about it, for the children of the
   * selected conversation (design §7.2's transient progress).
   *
   * The REST list lags the gateway by up to twenty seconds — `subagent_progress`
   * is deliberately not a list trigger, because a busy child emits many — and
   * that is exactly the window in which a user answers a question. A message
   * to a child the gateway thinks is PARKED takes `sendToChild`'s answering
   * branch: no turn, no `accepted`, no persisted user row. An optimistic row
   * for it is a sentence the child's transcript will never contain.
   *
   * The STORE reads this, not the panel, so D7's "the panel is REST-only"
   * ruling stands and `subagent_progress` is still not a list trigger.
   *
   * Deliberately not sticky: a child that parks and runs again is steerable
   * again, and a finish deletes the entry outright — D3's lesson that a
   * persisted `done` folded into a live view reads `done` for the whole
   * resumed run.
   */
  const childLiveStatus = new Map<string, 'running' | 'waiting'>();

  const recordChildLiveStatus = (event: MobileAgentEvent): void => {
    const childId = subagentIdOf(event);
    if (!childId) return;
    if (event.type === 'subagent_progress') {
      childLiveStatus.set(childId, event.status === 'waiting_input' ? 'waiting' : 'running');
      return;
    }
    if (event.type === 'subagent_finished') {
      childLiveStatus.delete(childId);
    }
  };

  const rememberLocalRow = (subagentId: string, messageId: string): void => {
    const rows = localChildRows.get(subagentId) ?? new Set<string>();
    rows.add(messageId);
    localChildRows.set(subagentId, rows);
  };

  const nextChildOrdinal = (transcript: ConversationMessage[]): number =>
    transcript.reduce((highest, row) => Math.max(highest, row.ordinal), 0) + 1;

  const patchSubagentUi = (subagentId: string, patch: Partial<SubagentUiState>): void => {
    set((state) => ({
      subagentUi: {
        ...state.subagentUi,
        [subagentId]: { ...BLANK_SUBAGENT_UI, ...state.subagentUi[subagentId], ...patch },
      },
    }));
  };

  /** Rewrite a child's transcript in place, leaving `transcriptLoaded` alone. */
  const patchChildTranscript = (
    subagentId: string,
    rewrite: (transcript: ConversationMessage[]) => ConversationMessage[],
  ): void => {
    const current = get().subagentUi[subagentId]?.transcript ?? [];
    patchSubagentUi(subagentId, { transcript: rewrite(current) });
  };

  /**
   * A watched child's own frame (design §8.3). It builds the same thing a REST
   * read would have: a streaming assistant message on `accepted`, its events as
   * they arrive, finished on `done`.
   *
   * Deliberately NOT `applySequencedFrame`. That gates on `lastSeq + 1` and
   * calls `refreshTerminal` on a gap, and a subscription routinely begins in
   * the middle of a turn — the transport already delivers these in order and
   * drops what it has seen (`deliverSubscribed`).
   */
  const applySubagentFrame = (subagentId: string, frame: MobileWsServerFrame): void => {
    if (frame.type === 'accepted') {
      const now = new Date().toISOString();
      patchChildTranscript(subagentId, (transcript) => {
        // The echo (§7.6) is the only correlation there is between the message
        // this client sent and the turn it became. Pairing here gives the local
        // row the server's own id, so the next REST page supersedes it instead
        // of landing beside it.
        //
        // Matched on the OPTIMISTIC row's own id shape, which is the same
        // hardening `apps/web` took (`store.ts`'s `m.turnId === m.id`): a
        // `requestId` is a value the CLIENT chose and the `accepted` echoing it
        // reaches every sink subscribed to this child, so a co-authorised peer
        // can name any id it likes. `pending:<requestId>` is a shape only this
        // client mints — a persisted server row can never satisfy it — while
        // this store's own row always does. Not a `localChildRows` lookup: that
        // set's bookkeeping is asymmetric, and the check does not need it.
        const paired = frame.requestId
          ? transcript.map((row) =>
              row.role === 'user' && row.id === `pending:${frame.requestId}`
                ? { ...row, id: frame.userMessageId, turnId: frame.id }
                : row,
            )
          : transcript;
        if (frame.requestId) {
          const local = localChildRows.get(subagentId);
          if (local?.delete(frame.requestId)) local.add(frame.userMessageId);
          rememberLocalRow(subagentId, frame.userMessageId);
        }
        rememberLocalRow(subagentId, frame.assistantMessageId);
        return [
          ...paired,
          {
            id: frame.assistantMessageId,
            conversationId: subagentId,
            turnId: frame.id,
            ordinal: nextChildOrdinal(paired),
            role: 'assistant',
            status: 'streaming',
            content: { type: 'assistant', events: [] },
            createdAt: now,
            updatedAt: now,
          } satisfies ConversationMessage,
        ];
      });
      return;
    }
    if (frame.type === 'event') {
      patchChildTranscript(subagentId, (transcript) =>
        transcript.map((row) =>
          row.turnId === frame.id && row.status === 'streaming' && row.content.type === 'assistant'
            ? {
                ...row,
                content: { type: 'assistant', events: [...row.content.events, frame.event] },
              }
            : row,
        ),
      );
      return;
    }
    if (frame.type !== 'done' && frame.type !== 'error') return;
    // A no-op over a row that is already finished. `done` can arrive after a
    // REST read has landed the completed row — the collapse window, or a
    // reconnect — and rewriting it there costs the content this stream never
    // carried (web D2 fix round 4, guard 1).
    const finished: ConversationMessage['status'] =
      frame.type === 'error' ? 'failed' : frame.outcome === 'cancelled' ? 'cancelled' : 'completed';
    patchChildTranscript(subagentId, (transcript) =>
      transcript.map((row) =>
        row.turnId === frame.id && row.status === 'streaming' ? { ...row, status: finished } : row,
      ),
    );
    // The child's turn ending changes its row in the list, and the page the
    // stream built is missing everything that happened before the subscription
    // started. Both re-reads are the same recovery `resumeSubagent` does.
    void get().refreshSubagents();
    if (get().subagentUi[subagentId]?.transcriptLoaded) {
      void get().loadSubagentTranscript(subagentId, true);
    }
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
    // Released HERE and synchronously, rather than left to the cards' own
    // effects: a conversation switch unmounts them a commit later, and until it
    // does main is holding sockets on children of a conversation nobody is
    // looking at. The count is dropped with them, so the cards' own releases
    // find nothing to release and send no second frame.
    for (const subagentId of [...childSubscriptions.keys()]) {
      childSubscriptions.delete(subagentId);
      window.api.subagentUnsubscribe(subagentId);
    }
    knownChildIds.clear();
    localChildRows.clear();
    childLiveStatus.clear();
    set({ subagents: [], subagentUi: {} });
  };

  /**
   * Make a selection change that did NOT go through `selectConversation` do
   * what one does: forget the previous conversation's children and read the new
   * selection's. Two paths reach here — `closeTab` and `purgeConversation` —
   * and both run `selectedAfterRemoval`, so both can move the selection while
   * `subagents` and `subagentUi`, which describe ONE conversation, keep
   * describing the conversation that has just gone. Left alone the panel draws
   * the old children under the new tab's transcript, and there is nothing to
   * correct it: the 20 s poll is armed by the LIST changing identity, which a
   * removal does not do, so with every child terminal no timer is running at
   * all.
   *
   * Clearing alone is not enough for the same reason — an empty list disarms
   * the poll and nothing would ever refill it — so this clears and re-reads.
   * The re-read carries D3's guards: `clearSubagents` bumps both counters, so a
   * read still in flight for the conversation being left is already behind the
   * cursor when it lands.
   *
   * Pass the selection as it was BEFORE the `set`; an unchanged selection is a
   * non-change and must not disturb the children on screen.
   */
  const followSelectionSwitch = (before: ConversationRef | null): void => {
    const after = get().selectedConversationRef;
    if (keyOrNull(before) === keyOrNull(after)) return;
    clearSubagents();
    void get().refreshSubagents();
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
      // `selectConversation`; closing any other leaves the selection, and the
      // children, alone. See `followSelectionSwitch`.
      followSelectionSwitch(before);
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
      if (!conversation) return;
      if (!turnId) {
        // D3's exit. `sending[key]` is optimistic and `refreshTerminal` — the
        // only thing that clears it — runs only from a `done`/`error` frame or
        // a seq gap. Lose that frame and a later authoritative read puts
        // `activeTurnId` back to `null`, leaving the composer locked on a flag
        // nothing can now clear: disabled composer, disabled Send, gateway
        // idle, window reload the only way out.
        //
        // There is nothing to cancel on the server, and that is precisely why
        // this branch must still run: the wedge is entirely local, so clearing
        // it locally is the whole repair. Safe against a genuinely in-flight
        // turn, which by definition has a `turnId` and takes the branch below.
        set((state) => ({
          sending: { ...state.sending, [key]: false },
          streamingFrames: { ...state.streamingFrames, [key]: [] },
          localTurnIds: { ...state.localTurnIds, [key]: undefined },
        }));
        return;
      }
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
      if (isVoiceServerFrame(frame)) return;
      if (!frame.conversationId) return;
      // Ruling 4: a child's frames belong to the child's transcript. Ahead of
      // everything below, because the conversation path would key
      // `messages`/`streamingFrames` by the CHILD's id and then send its `done`
      // through `refreshTerminal` — a `chatGetMessages` that opens a second,
      // turn-scoped socket on a conversation this client already watches.
      const selected = get().selectedConversationRef;
      if (knownChildIds.has(frame.conversationId) && frame.conversationId !== selected?.id) {
        applySubagentFrame(frame.conversationId, frame);
        return;
      }
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
      // Scoped to the SELECTED conversation, the same gate the list triggers
      // use: a grandchild's progress inside a subscribed child says nothing
      // about this conversation's own children. Recorded ahead of the sequence
      // gate, because what the frame SAYS is true whether or not it arrived
      // contiguously.
      if (frame.type === 'event' && selected && selected.id === frame.conversationId) {
        recordChildLiveStatus(frame.event);
      }
      if (frame.type === 'event' && SUBAGENT_LIST_TRIGGERS.has(frame.event.type)) {
        const selected = get().selectedConversationRef;
        if (selected && selected.id === frame.conversationId) {
          void get().refreshSubagents();
        }
      }
      // A conversation this renderer has NO record of is one it inherited from
      // a socket a previous renderer opened. A macOS window close leaves
      // main's sockets running; the dock-icon click that follows builds a
      // fresh renderer with an empty `knownChildIds`, and a child frame still
      // in flight lands here.
      //
      // `refreshTerminal` is the only thing that must not run for it:
      // `chatGetMessages` reaches `ChatService.getMessages`, which subscribes
      // the resumable transport to the running turn — a SECOND, turn-scoped
      // socket on a conversation main already watches. Withhold the recovery,
      // not the frame; a conversation with no tab and no selection renders
      // nothing anyway. Children are never in the list (the gateway hides
      // them from `list` unless the caller names their kind), so this cannot
      // withhold a recovery a child card wanted.
      //
      // "This renderer has READ it" leads, because list membership is the
      // unreliable part: `reconcileFirstPage` does not merge, so a
      // conversation that got into `conversations` by an upsert rather than by
      // page 1 — a project session's — is EVICTED by any first page that does
      // not carry it, and mid-turn that would strip it of the recovery that
      // clears `sending`.
      //
      // `messages` is not structurally child-free — the `accepted` branch
      // below writes `messages[key]` for whatever conversation the frame names.
      // What bounds it is REACHABILITY: that write is past
      // `applySequencedFrame`, which drops anything but `seq === lastSeq + 1`,
      // and an unknown conversation's `lastSeq` is 0. So a child key can only
      // enter `messages` through an unrouted `accepted` at `seq === 1` — a
      // child's very first frame ever — which an inherited MID-STREAM socket
      // cannot deliver. (D7b M3 review, Minor 4, correcting the blanket
      // sentence that stood here and in `96c86f8a`'s message.)
      const recoverable =
        keyOrNull(get().selectedConversationRef) === key ||
        Object.hasOwn(get().messages, key) ||
        get().conversations.some((conversation) => sameConversation(conversation, ref));
      // A TRANSIENT event (spec §7.2 — `subagent_progress` today) carries no
      // `seq`: the hub broadcasts it and never appends it to the durable log
      // (`resumable-chat-hub.ts:382-390`, `isTransientAgentEvent`). D5 taught
      // this to the MAIN-process transport (`98ec7e11`); the RENDERER's own
      // sequencer still dropped it one layer down, because `applySequencedFrame`
      // returns the state UNCHANGED for a frame with no `seq` and the
      // `applied.state === current` guard below then reads that as "nothing to
      // do". The frame never reached `streamingFrames`, which is the array the
      // card fold walks — for the chat route (`chat.tsx:2307`) and for a
      // project session alike (`SessionPanel.tsx:45,128`, same `MessageBubble`,
      // same fold, so both surfaces move and both inherit the anchored gate
      // below). So a child parked on `ask_orchestrator` showed no
      // waiting glyph, no question and no reply box on its COLLAPSED row (the
      // one live §32.6 FAIL), and no card's tool count or elapsed detail ever
      // moved. Every store test for progress minted a synthetic `seq`, and none
      // of the four captured gateway streams contains a `waiting_input` frame,
      // so nothing was red about it.
      //
      // Delivered, but NOT sequenced: a transient event is not a position in
      // the log, so it must neither move `lastSeq` nor read as a gap — the same
      // rule `98ec7e11` states for the transport. It must also not write the
      // conversation's `status`/`activeTurnId` the way the sequenced path
      // below does; a background child's heartbeat outlives its launching turn
      // and would mark an idle parent `running` again.
      //
      // Gated on the child being ANCHORED in the stream that is live — not on
      // a stream merely existing. "Is anything live" and "is this child's card
      // here" diverge for a BACKGROUND child, the only kind that outlives its
      // launching turn: `run.ts:268` (`if (h.background) continue;`) leaves it
      // running through the turn's finalize, and `emitToParent`
      // (`coordinator.ts:1560`) pushes its heartbeat into whatever turn is live
      // NOW, because `this.live` is keyed `(agentId, conversationId)`. So a
      // turn-1 child heartbeats onto turn 2's stream, where it has no
      // `subagent_started` — and `groupSubagentEvents` (`chat.swarm.ts:373-381`)
      // drafts a card for any `subagentIdOf` hit, clearing `orphan` only on a
      // start. The result is a second, unlabelled card carrying the question
      // and the `subagent-reply` composer for a child whose real card is
      // already in a confirmed message: D2's class, and out of reach of D2's
      // fix, because `liveEvents` (`chat.tsx:2308`) is built straight off this
      // array and never goes through `mergeSubagentEventLists`. The anchored
      // rule subsumes the emptied-stream case — an emptied array anchors
      // nothing — and keeps §32.6 verbatim: a foreground child parked on
      // `ask_orchestrator` inside the live turn is anchored in that same
      // stream. A transient frame updates the stream it belongs to or it is
      // dropped.
      //
      // Coalesced, not appended: `PROGRESS_THROTTLE_MS` is 1_000
      // (`child-handle.ts:75`), so a busy child emits one of these a second for
      // the whole turn, and the fold is last-write-wins per child — every
      // heartbeat but the newest is dead weight in an array `groupSubagentEvents`
      // re-walks on each one. Replaced in PLACE, so the array holds at most one
      // per child and no anchor index the fold reads ever moves.
      if (frame.type === 'event' && frame.seq === undefined) {
        // `isTransientAgentEvent` is `subagent_progress` and only it
        // (`transient-events.ts:12-14`), so a seq-less frame always names a
        // child today. A future non-sub-agent transient type needs its own
        // rule here rather than a silent fall-through to delivery.
        const childId = subagentIdOf(frame.event);
        if (childId === undefined) return;
        const anchored = current.frames.some(
          (candidate) =>
            candidate.type === 'event' &&
            candidate.event.type === 'subagent_started' &&
            subagentIdOf(candidate.event) === childId,
        );
        if (!anchored) return;
        set((state) => {
          const frames = state.streamingFrames[key] ?? [];
          const previous = frames.findIndex(
            (candidate) =>
              candidate.type === 'event' &&
              candidate.seq === undefined &&
              subagentIdOf(candidate.event) === childId,
          );
          return {
            streamingFrames: {
              ...state.streamingFrames,
              [key]:
                previous === -1
                  ? [...frames, frame]
                  : frames.map((candidate, index) => (index === previous ? frame : candidate)),
            },
          };
        });
        return;
      }
      const applied = applySequencedFrame(current, frame);
      if (applied.gapAfter !== null) {
        if (recoverable) await refreshTerminal(ref);
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
      if ((frame.type === 'done' || frame.type === 'error') && recoverable) {
        await refreshTerminal(ref);
      }
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

    subscribeSubagent(subagentId) {
      const held = childSubscriptions.get(subagentId);
      if (held) {
        held.holds += 1;
        // Re-taking a hold whose socket is DEAD is the only moment this client
        // can ask for it back. Main's own `subscribeConversation` is never
        // re-entered for a conversation already held — the count above returns
        // before any IPC — so under the two-holder shape the rulings create
        // (the panel open AND a card expanded) collapsing and re-expanding
        // never reaches 0, and nothing revives a watch killed by 4001 / 4401 /
        // 4429 or by an older gateway's `validation_failed`.
        //
        // A rewatch, not an unsubscribe-then-subscribe: the count must not
        // move, and only a `{ reopened: true }` watch fires the restore that
        // puts optimism back and forces the re-read the card is owed. A plain
        // first watch announces nothing and would leave optimism off forever.
        if (!held.live) window.api.subagentRewatch(held.agentId, subagentId);
        return;
      }
      // A child rides its PARENT's agent id: it belongs to the same agent, and
      // the gateway's hub keys its watcher registry on that pair. Without one
      // there is no frame to send, so no hold is taken either — a hold main
      // never heard of would be released against a count that never rose.
      const ref = get().selectedConversationRef;
      const agentId = ref && ref.origin === 'gateway' ? exactConversation(ref)?.agentId : undefined;
      if (!agentId) return;
      // Optimistically live: main answers with `chat:subagentWatchLost` if it
      // is not, and that round trip is faster than any message a user types.
      childSubscriptions.set(subagentId, { agentId, holds: 1, live: true });
      knownChildIds.add(subagentId);
      window.api.subagentSubscribe(agentId, subagentId);
    },

    /**
     * The bookkeeping is immediate; the wire frame is one microtask later.
     *
     * A card is remounted by things that have nothing to do with it — most
     * often the streaming bubble being swapped for the finalized message when
     * the parent's turn ends, which happens in ONE React commit. React runs the
     * removed subtree's cleanup before the added subtree's setup inside that
     * commit, so the count really does go 1 → 0 → 1 and a synchronous release
     * would put an `unsubscribe` on the wire. The gateway replays nothing on
     * the `subscribe` that follows (`apps/gateway/src/chat-ws.ts:425-427`), so
     * anything the child emitted in the gap is gone — including a `done`.
     *
     * Deferring closes it: both effects of the commit have run by the time the
     * microtask fires, and it re-checks the count.
     */
    unsubscribeSubagent(subagentId) {
      const held = childSubscriptions.get(subagentId);
      if (!held) return;
      held.holds -= 1;
      if (held.holds > 0) return;
      queueMicrotask(() => {
        const current = childSubscriptions.get(subagentId);
        // Re-taken by a remount, or already dropped by `clearSubagents`.
        if (!current || current.holds > 0) return;
        childSubscriptions.delete(subagentId);
        window.api.subagentUnsubscribe(subagentId);
        // The card now OWES itself a re-read (ruling 3, and web's D2 round 3
        // does the same by dropping the child from its loaded set). A
        // voluntary release is precisely the moment this client stops being
        // able to see the child's `done`, and it triggers none of the three
        // recoveries: no `done` reaches us, no `chat:subagentResubscribed`
        // fires, and no resume happens. `loadSubagentTranscript` early-returns
        // on `transcriptLoaded`, so without this the next expansion re-reads
        // nothing and the body stays at the partial sentence with a live
        // indicator until the conversation selection changes.
        //
        // Unconditional rather than gated on the child looking unfinished: the
        // read is cheap, the flag only says "a read is owed", and the rows
        // already on screen stay there until it lands.
        patchSubagentUi(subagentId, { transcriptLoaded: false });
      });
    },

    isSubagentSubscribed(subagentId) {
      const held = childSubscriptions.get(subagentId);
      // BOTH, and the second is the one D7b was missing. A hold is this
      // renderer's own bookkeeping and says nothing about whether anything is
      // watching: the socket factory can throw, the socket can close 4001 or
      // just 1006, an older gateway answers our `subscribe` with
      // `validation_failed` and leaves the socket open watching nothing, and
      // a hold can be taken while main has no transport at all. In every one
      // of those the echo this row would be paired by never arrives.
      return held !== undefined && held.holds > 0 && held.live;
    },

    markSubagentWatchLost(subagentId) {
      const held = childSubscriptions.get(subagentId);
      // Deliberately NOT `childSubscriptions.delete`. Deleting would break the
      // 1:1 pairing main's refcount depends on: a second card opening would
      // create a fresh entry and send a SECOND `subscribe`, and the first
      // card's release would then take the count to 0 and unwatch a child the
      // second is still showing.
      if (held) held.live = false;
    },

    async restoreSubagentTranscript(subagentId) {
      const held = childSubscriptions.get(subagentId);
      if (held) held.live = true;
      // The list first, and for every restored child rather than only the ones
      // with a card open: this is the one moment we KNOW a `done` may have
      // fallen in a gap, and a child held only by the panel has no transcript
      // to re-read but does have a row that would otherwise say `Running`
      // until the backstop poll came round.
      void get().refreshSubagents();
      if (!get().subagentUi[subagentId]?.transcriptLoaded) return;
      await get().loadSubagentTranscript(subagentId, true);
    },

    async loadSubagentTranscript(subagentId, force = false) {
      if (!force && get().subagentUi[subagentId]?.transcriptLoaded) return;
      try {
        const page = await window.api.conversationMessages(subagentId);
        // Sorted here rather than trusting the page order. The route does
        // return `ordinal ASC` today, but a card that renders `page.items`
        // verbatim depends on that silently — and the parent transcript does
        // not, since every page it reads goes through `mergeCanonicalMessages`.
        const items = [...page.items].sort((a, b) => a.ordinal - b.ordinal);
        const local = localChildRows.get(subagentId);
        const existing = get().subagentUi[subagentId]?.transcript ?? [];
        // A re-read is a RECOVERY, not a replacement. Every trigger for one —
        // a `done`, a restored stream, a resume — can land while a turn is
        // still streaming into this card, and the server's copy of a live row
        // is a snapshot taken before the events this store already holds.
        //
        // Both halves of ruling 3, and web paid four rounds for the pair
        // (`apps/web/src/state/store.ts`, D2 fix round 4). GUARD 2 — never
        // overwrite a finished row with an emptier one — lives in
        // `applySubagentFrame`'s `done`. GUARD 1 is here: clear the local
        // stream exactly when the SERVER says that turn is over. Without it a
        // `done` that fell in a reconnect gap is never recoverable — the
        // restore's re-read drops the server's `completed` copy in favour of
        // the fragment, and no further `done` is coming for that turn.
        const serverIds = new Set(items.map((row) => row.id));
        const serverTurns = new Set(items.map((row) => row.turnId));
        const serverStatus = new Map(items.map((row) => [row.id, row.status]));
        // A row the page does not carry at all counts as UNFINISHED, so a turn
        // that started while the fetch was in flight is kept rather than
        // wiped. That is the interleaving web's guard 1 broke on first.
        const finishedOnServer = (row: ConversationMessage): boolean =>
          (serverStatus.get(row.id) ?? 'streaming') !== 'streaming';
        const live = new Set(
          existing
            .filter(
              (row) => local?.has(row.id) && row.status === 'streaming' && !finishedOnServer(row),
            )
            .map((row) => row.id),
        );
        // The same predicate, and it has to be in BOTH: a row dropped from
        // `live` still matches the `streaming` escape below, and would then
        // survive BESIDE the server's copy — two rows for one turn.
        const kept = existing.filter(
          (row) =>
            local?.has(row.id) === true &&
            // Still streaming, and the server agrees: only this store knows
            // how far it has got.
            ((row.status === 'streaming' && !finishedOnServer(row)) ||
              // Otherwise it survives exactly until the server has it, by id or
              // by turn. That is what stops the user's own sentence appearing
              // twice once the child's turn is persisted.
              (!serverIds.has(row.id) && !serverTurns.has(row.turnId))),
        );
        const transcript = [...items.filter((row) => !live.has(row.id)), ...kept].sort(
          (a, b) => a.ordinal - b.ordinal,
        );
        for (const id of local ?? []) {
          if (!kept.some((row) => row.id === id)) local?.delete(id);
        }
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

    async resumeSubagent(subagentId, message, options) {
      patchSubagentUi(subagentId, { sending: true, notice: null });
      // The echo (§7.6) rides the CHILD conversation's stream, so it reaches
      // this client only while a subscription is held. That is the whole test
      // for showing the user's sentence early: an optimistic row with no
      // `accepted` coming is a row nothing can pair, and the next REST page
      // lands the server's copy of it beside it.
      const requestId = crypto.randomUUID();
      const entry = get().subagents.find((child) => child.id === subagentId);
      // ...with one exception the gateway's own shape forces. A message to a
      // child PARKED on a question is an ANSWER: `sendToChild`'s answering
      // branch resolves the waiter (`packages/swarm/src/child-handle.ts:386`),
      // which starts no turn, emits no `accepted`, and persists no user row.
      // A row for it would be a sentence the child's transcript never contains
      // and nothing would ever supersede.
      //
      // Read from the CALLER first, and only then from the list. The reply box
      // is drawn by the FOLD: `resolveSubagentQuestion` shows the question the
      // instant a `subagent_progress { status: 'waiting_input' }` lands on the
      // parent's stream, gated only on the resolved status not being terminal.
      // `subagent_progress` is deliberately not a list trigger
      // (`SUBAGENT_LIST_TRIGGERS`), so REST goes on saying `running` until the
      // next start, finish, stop, resume, selection or 20 s poll — while the
      // user is looking at the question and answering it. The gateway has no
      // such lag (`waitForQuestion` persists `waiting_input` at
      // `packages/swarm/src/child-handle.ts:419`), so it takes the answering
      // branch and this client is the only one that got it wrong.
      //
      // The list is still consulted, for the panel's Resume button and the
      // body composer: those are REST-driven surfaces, so their two sources
      // agree, and a child the list says is `waiting` is parked whoever asks.
      //
      // Three sources, narrowest first. The caller's flag is the only one the
      // question composer needs. `childLiveStatus` closes the panel's Resume
      // and the body composer for a child whose parking THIS client has
      // already seen — the store holds the frame the render sites cannot. The
      // list is the backstop and is right once it catches up.
      const parked =
        options?.answering === true ||
        childLiveStatus.get(subagentId) === 'waiting' ||
        (entry !== undefined && rowStatusOf(entry.status) === 'waiting');
      const optimistic = get().isSubagentSubscribed(subagentId) && !parked;
      if (optimistic) {
        const now = new Date().toISOString();
        rememberLocalRow(subagentId, `pending:${requestId}`);
        patchChildTranscript(subagentId, (transcript) => [
          ...transcript,
          {
            id: `pending:${requestId}`,
            conversationId: subagentId,
            turnId: requestId,
            ordinal: nextChildOrdinal(transcript),
            role: 'user',
            status: 'completed',
            content: { type: 'user', text: message },
            createdAt: now,
            updatedAt: now,
          } satisfies ConversationMessage,
        ]);
      }
      let accepted = false;
      try {
        const result = await window.api.subagentResume(subagentId, message, requestId);
        if (result.ok) accepted = true;
        else patchSubagentUi(subagentId, { sending: false, notice: result.reason });
      } catch (error) {
        patchSubagentUi(subagentId, { sending: false, notice: reasonOf(error) });
      }
      // The draft survives a refusal — the user's sentence is still worth
      // something once they know why it bounced. The optimistic ROW does not:
      // it claims the child received this, and it did not.
      if (!accepted) {
        if (optimistic) {
          localChildRows.get(subagentId)?.delete(`pending:${requestId}`);
          patchChildTranscript(subagentId, (transcript) =>
            transcript.filter((row) => row.id !== `pending:${requestId}`),
          );
        }
        return false;
      }
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
 * A BACKSTOP, and D7b kept it deliberately rather than removing it (ruling 6).
 *
 * The conversation-scoped subscription replaced this poll for every child
 * something is WATCHING — an expanded card, or any non-terminal child while
 * the tasks panel is open. Those get their status from their own stream: a
 * `done` on the child's socket re-reads the list (`applySubagentFrame`).
 *
 * The case it does NOT cover, and the reason this stays: a non-terminal child
 * with NO holder. A collapsed row in the transcript, with the panel closed,
 * has a status pill and an elapsed clock and nothing feeding either —
 * `swarm:run-changed` is throttled to one per run per second with no trailing
 * emit, and no `subagent_*` frame reaches this client unless a PARENT turn is
 * streaming. Without this the row would say `Running` for the rest of the
 * session.
 *
 * Deliberately NOT narrowed to "some non-terminal child has no holder", which
 * would be the tighter condition: this subscriber only re-runs when
 * `subagents` changes identity, so a card COLLAPSING would not re-arm a poll
 * that had stopped, and nothing else would ever read the list again. Armed by
 * the children alone, it cannot wedge. Do not grow it.
 *
 * This and the subscription are NOT prevented from firing a re-read for the
 * same event: `applySubagentFrame`'s `done` tail calls `refreshSubagents` and
 * so does this interval, and the two can overlap. They are made IDEMPOTENT
 * instead, by the `subagentReadSeq`/`appliedSubagentSeq` cursor — the newest
 * read that STARTED is the only one allowed to write, so whichever order two
 * overlapping responses land in, the newer wins and the older is dropped.
 * That is the honest statement of it; "they cannot both fire" would not be.
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
  // A watched child's stream dropped and came back. Main has already
  // re-subscribed; what it cannot do is recover the gap.
  window.api.onSubagentResubscribed((subagentId) => {
    void useChatStore
      .getState()
      .restoreSubagentTranscript(subagentId)
      .catch(() => undefined);
  });
  // A watched child's socket is not open. The hold stays; optimism stops.
  window.api.onSubagentWatchLost((subagentId) => {
    useChatStore.getState().markSubagentWatchLost(subagentId);
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
