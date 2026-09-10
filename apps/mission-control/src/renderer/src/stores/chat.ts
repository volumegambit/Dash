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
import type {
  MobileV2ConversationBootstrap,
  MobileV2ConversationSummary,
  MobileV2PendingInput,
  MobileV2WsServerFrame,
} from '@dash/mobile-contract-v2';
import { create } from 'zustand';
import {
  type ChatConnectionIssue,
  type ChatV2CommandIssue,
  ConversationChatSupersededError,
  type ConversationInvalidation,
  type McAgentEvent,
} from '../../../shared/ipc.js';
import {
  applySequencedFrame,
  mergeCanonicalMessages,
  replaceAcceptedOptimisticMessage,
} from './chat-sync.js';
import {
  type V2ConversationProjection,
  type V2OrdinarySendIntent,
  applyV2Frame as applyV2ProjectionFrame,
  prependV2MessagePage,
  projectionFromBootstrap,
  reconcileV2Accepted,
} from './chat-v2-sync.js';

export type {
  V2ConversationProjection,
  V2IdentityBridges,
  V2LiveSegment,
  V2OrdinarySendIntent,
  V2TimelineEntry,
} from './chat-v2-sync.js';

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

export type ProtocolAwareConversationSource =
  | { protocol: 'v1'; summary: McConversationView }
  | { protocol: 'v2'; summary: MobileV2ConversationSummary };

export interface MainChatSelectionReservation {
  surfaceGeneration: number;
  selectionGeneration: number;
}

export interface PendingV2LegacyCommand {
  localDispatchToken: string;
  wireCommandId: string;
  runId: string;
  kind: 'cancel' | 'answer';
  questionId?: string;
}

export interface V2AnswerAttempt {
  runId: string;
  questionId: string;
  answer: string;
  state: 'pending' | 'ended' | 'rejected';
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
  connectionIssue: ChatConnectionIssue | null;
  protocolByConversation: Record<ConversationKey, 'v1' | 'v2'>;
  v2Projections: Record<ConversationKey, V2ConversationProjection>;
  subscribedV2Conversations: Record<ConversationKey, ConversationRef | undefined>;
  openingPromiseByConversation: Record<ConversationKey, Promise<void> | undefined>;
  openGenerationByConversation: Record<ConversationKey, number>;
  projectionEpochByConversation: Record<ConversationKey, number>;
  conversationOwnersByConversation: Record<ConversationKey, string[]>;
  ordinarySendIntentsByConversation: Record<ConversationKey, Record<string, V2OrdinarySendIntent>>;
  pendingV2LegacyCommandsByConversation: Record<
    ConversationKey,
    Record<string, PendingV2LegacyCommand>
  >;
  commandIssuesByConversation: Record<ConversationKey, ChatV2CommandIssue | undefined>;
  answerAttemptsByConversation: Record<ConversationKey, Record<string, V2AnswerAttempt>>;
  mainChatSurfaceGeneration: number;
  mainChatSurfaceActive: boolean;
  mainChatSelectionGeneration: number;

  loadConversations(): Promise<void>;
  loadMoreConversations(): Promise<void>;
  ensureConversation(ref: ConversationRef): Promise<McConversationView | null>;
  ensureMessages(ref: ConversationRef): Promise<void>;
  loadOlderMessages(ref: ConversationRef): Promise<void>;
  openConversation(ref: ConversationRef, ownerId: string): Promise<void>;
  closeConversation(ref: ConversationRef, ownerId: string): Promise<void>;
  reserveMainChatSelection(): MainChatSelectionReservation;
  selectConversation(
    ref: ConversationRef,
    reservation?: MainChatSelectionReservation,
  ): Promise<void>;
  retainMainChatSurface(): () => void;
  openTab(ref: ConversationRef): void;
  closeTab(key: ConversationKey): void;
  createConversation(
    agentId: string,
    reservation?: MainChatSelectionReservation,
  ): Promise<McConversationView>;
  renameConversation(ref: ConversationRef, title: string): Promise<void>;
  deleteConversation(ref: ConversationRef): Promise<void>;
  sendMessage(
    ref: ConversationRef,
    text: string,
    images?: MobileImage[],
    draftRevision?: number,
  ): Promise<void>;
  enqueueInput(
    ref: ConversationRef,
    input: { behavior: 'steer' | 'followUp'; text: string; images?: MobileImage[] },
  ): Promise<MobileV2PendingInput>;
  editFollowUp(
    ref: ConversationRef,
    inputId: string,
    expectedRevision: number,
    text: string,
    images?: MobileImage[],
  ): Promise<MobileV2PendingInput>;
  removeFollowUp(ref: ConversationRef, inputId: string, expectedRevision: number): Promise<void>;
  resumeFollowUps(ref: ConversationRef): Promise<void>;
  cancelMessage(ref: ConversationRef): void;
  answerQuestion(ref: ConversationRef, questionId: string, answer: string): void;
  applyFrame(frame: MobileWsServerFrame): Promise<void>;
  applyV2Frame(frame: MobileV2WsServerFrame): Promise<void>;
  handleV2CommandIssue(issue: ChatV2CommandIssue): void;
  clearCommandIssue(ref: ConversationRef): void;
  handleConnectionIssue(issue: ChatConnectionIssue): void;
  invalidateConversation(event: ConversationInvalidation): Promise<void>;
}

export function conversationSourceFor(
  state: ChatState,
  ref: ConversationRef,
): ProtocolAwareConversationSource | null {
  const key = conversationKey(ref);
  if (state.protocolByConversation[key] === 'v2') {
    const projection = state.v2Projections[key];
    return projection ? { protocol: 'v2', summary: projection.conversation } : null;
  }
  const summary = state.conversations.find((conversation) => sameConversation(conversation, ref));
  return summary ? { protocol: 'v1', summary } : null;
}

function reconcileV2ConversationSummary(
  current: MobileV2ConversationSummary,
  authoritative: McConversationView,
): MobileV2ConversationSummary {
  return {
    ...current,
    id: authoritative.id,
    agentId: authoritative.agentId,
    agentName: authoritative.agentName,
    title: authoritative.title,
    revision: authoritative.revision,
    status: authoritative.status,
    activeTurnId: authoritative.activeTurnId,
    owningIssueId: authoritative.owningIssueId,
    projectId: authoritative.projectId,
    lastSeq: authoritative.lastSeq,
    lastMessagePreview: authoritative.lastMessagePreview,
    createdAt: authoritative.createdAt,
    updatedAt: authoritative.updatedAt,
    ...(authoritative.deletedAt ? { deletedAt: authoritative.deletedAt } : {}),
  };
}

function conversationViewFromSource(
  source: ProtocolAwareConversationSource,
  local: Pick<McConversationView, 'origin' | 'offline' | 'readOnly'>,
): McConversationView {
  const summary = source.summary;
  return {
    id: summary.id,
    agentId: summary.agentId,
    agentName: summary.agentName,
    title: summary.title,
    revision: summary.revision,
    status: summary.status,
    activeTurnId: summary.activeTurnId,
    owningIssueId: summary.owningIssueId,
    projectId: summary.projectId,
    lastSeq: summary.lastSeq,
    lastMessagePreview: summary.lastMessagePreview,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    ...(summary.deletedAt ? { deletedAt: summary.deletedAt } : {}),
    ...local,
  };
}

function protocolMismatch(expected: 'v1' | 'v2', received: string): Error {
  return new Error(`Conversation protocol mismatch: expected ${expected}, received ${received}`);
}

function copiedImages(images: MobileImage[] | undefined): MobileImage[] | undefined {
  return images?.map((image) => ({ ...image }));
}

function reconcileAnswerAttempts(
  attempts: Record<string, V2AnswerAttempt> | undefined,
  activeTurnId: string | null,
): Record<string, V2AnswerAttempt> {
  const next: Record<string, V2AnswerAttempt> = {};
  for (const [questionId, attempt] of Object.entries(attempts ?? {})) {
    next[questionId] =
      attempt.runId === activeTurnId ? attempt : { ...attempt, state: 'ended' as const };
  }
  return next;
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
  const refreshPromiseByConversation = new Map<
    ConversationKey,
    { openGeneration: number; projectionEpoch: number; task: Promise<void> }
  >();

  const upsertConversation = (conversation: McConversationView): void => {
    set((state) => ({
      conversations: mergeConversations(state.conversations, [conversation]),
    }));
  };

  const reconcileAuthoritativeConversation = (conversation: McConversationView): void => {
    const key = conversationKey(refFor(conversation));
    set((state) => {
      const projection = state.v2Projections[key];
      const shouldUpdateV2 =
        state.protocolByConversation[key] === 'v2' &&
        projection &&
        conversation.revision >= projection.conversation.revision;
      return {
        conversations: mergeConversations(state.conversations, [conversation]),
        v2Projections: shouldUpdateV2
          ? {
              ...state.v2Projections,
              [key]: {
                ...projection,
                conversation: reconcileV2ConversationSummary(projection.conversation, conversation),
              },
            }
          : state.v2Projections,
      };
    });
  };

  const reconcileRevisionConflict = (
    ref: ConversationRef,
    current: Record<string, unknown>,
  ): void => {
    const state = get();
    const source = conversationSourceFor(state, ref);
    const conversation = state.conversations.find((candidate) => sameConversation(candidate, ref));
    if (!source || !conversation) return;
    const baseline = conversationViewFromSource(source, {
      origin: conversation.origin,
      offline: conversation.offline,
      readOnly: conversation.readOnly,
    });
    reconcileAuthoritativeConversation({
      ...baseline,
      ...current,
      origin: baseline.origin,
      offline: baseline.offline,
      readOnly: baseline.readOnly,
    } as McConversationView);
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

  const selectionReservationIsCurrent = (reservation: MainChatSelectionReservation): boolean => {
    const state = get();
    return (
      state.mainChatSurfaceGeneration === reservation.surfaceGeneration &&
      state.mainChatSelectionGeneration === reservation.selectionGeneration
    );
  };

  const purgeConversation = (
    ref: ConversationRef,
    selectionReservation?: MainChatSelectionReservation,
  ): void => {
    const key = conversationKey(ref);
    const before = get();
    const openTabKeys = before.openTabKeys.filter((tab) => tab !== key);
    const wasSelected = Boolean(
      before.selectedConversationRef && conversationKey(before.selectedConversationRef) === key,
    );
    if (
      wasSelected &&
      selectionReservation &&
      !selectionReservationIsCurrent(selectionReservation)
    ) {
      return;
    }
    const replacement = wasSelected
      ? selectedAfterRemoval(before, key, openTabKeys)
      : before.selectedConversationRef;
    const reservation = wasSelected
      ? (selectionReservation ?? get().reserveMainChatSelection())
      : null;
    const shouldUnsubscribe =
      before.protocolByConversation[key] === 'v2' &&
      (before.conversationOwnersByConversation[key]?.length ?? 0) > 0;
    set((state) => {
      const unread = new Set(state.unreadConversations);
      unread.delete(key);
      return {
        conversations: state.conversations.filter(
          (conversation) => !sameConversation(conversation, ref),
        ),
        selectedConversationRef: replacement,
        openTabKeys,
        messages: withoutKey(state.messages, key),
        messageCursor: withoutKey(state.messageCursor, key),
        throughSeq: withoutKey(state.throughSeq, key),
        streamingFrames: withoutKey(state.streamingFrames, key),
        lastSeq: withoutKey(state.lastSeq, key),
        localTurnIds: withoutKey(state.localTurnIds, key),
        sending: withoutKey(state.sending, key),
        protocolByConversation: withoutKey(state.protocolByConversation, key),
        v2Projections: withoutKey(state.v2Projections, key),
        subscribedV2Conversations: withoutKey(state.subscribedV2Conversations, key),
        openingPromiseByConversation: withoutKey(state.openingPromiseByConversation, key),
        openGenerationByConversation: {
          ...state.openGenerationByConversation,
          [key]: (state.openGenerationByConversation[key] ?? 0) + 1,
        },
        projectionEpochByConversation: withoutKey(state.projectionEpochByConversation, key),
        conversationOwnersByConversation: withoutKey(state.conversationOwnersByConversation, key),
        ordinarySendIntentsByConversation: withoutKey(state.ordinarySendIntentsByConversation, key),
        pendingV2LegacyCommandsByConversation: withoutKey(
          state.pendingV2LegacyCommandsByConversation,
          key,
        ),
        commandIssuesByConversation: withoutKey(state.commandIssuesByConversation, key),
        answerAttemptsByConversation: withoutKey(state.answerAttemptsByConversation, key),
        unreadConversations: unread,
      };
    });
    if (shouldUnsubscribe) {
      void window.api.chatUnsubscribeV2(ref).catch(() => undefined);
    }
    if (
      wasSelected &&
      replacement &&
      reservation &&
      before.mainChatSurfaceActive &&
      get().mainChatSurfaceGeneration === reservation.surfaceGeneration &&
      get().mainChatSelectionGeneration === reservation.selectionGeneration
    ) {
      void get()
        .openConversation(replacement, 'main-chat')
        .catch(() => undefined);
    }
  };

  const exactConversation = (ref: ConversationRef): McConversationView | undefined =>
    get().conversations.find((conversation) => sameConversation(conversation, ref));

  const assertMutable = (
    ref: ConversationRef,
  ): { conversation: McConversationView; source: ProtocolAwareConversationSource } => {
    const source = conversationSourceFor(get(), ref);
    const conversation = exactConversation(ref);
    if (!source || !conversation) throw new Error('Conversation not found');
    if (
      !get().gatewayOnline ||
      conversation.offline ||
      conversation.readOnly ||
      source.summary.status === 'archived' ||
      source.summary.status === 'deleted' ||
      source.summary.status === 'running' ||
      source.summary.activeTurnId !== null
    ) {
      throw new Error('This conversation is read-only');
    }
    return { conversation, source };
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

  const installV2Bootstrap = (
    ref: ConversationRef,
    bootstrap: MobileV2ConversationBootstrap,
  ): void => {
    const key = conversationKey(ref);
    set((state) => {
      const activeTurnId = bootstrap.conversation.activeTurnId;
      const commands = Object.fromEntries(
        Object.entries(state.pendingV2LegacyCommandsByConversation[key] ?? {}).filter(
          ([, command]) => command.runId === activeTurnId,
        ),
      );
      return {
        protocolByConversation: { ...state.protocolByConversation, [key]: 'v2' },
        v2Projections: {
          ...state.v2Projections,
          [key]: projectionFromBootstrap(bootstrap),
        },
        projectionEpochByConversation: {
          ...state.projectionEpochByConversation,
          [key]: (state.projectionEpochByConversation[key] ?? 0) + 1,
        },
        answerAttemptsByConversation: {
          ...state.answerAttemptsByConversation,
          [key]: reconcileAnswerAttempts(state.answerAttemptsByConversation[key], activeTurnId),
        },
        pendingV2LegacyCommandsByConversation: {
          ...state.pendingV2LegacyCommandsByConversation,
          [key]: commands,
        },
      };
    });
  };

  const refreshV2Projection = (ref: ConversationRef): Promise<void> => {
    const key = conversationKey(ref);
    const initial = get();
    const generation = initial.openGenerationByConversation[key] ?? 0;
    const epoch = initial.projectionEpochByConversation[key] ?? 0;
    const existing = refreshPromiseByConversation.get(key);
    if (existing?.openGeneration === generation && existing.projectionEpoch === epoch) {
      return existing.task;
    }
    const subscribed = initial.subscribedV2Conversations[key];
    const opening = initial.openingPromiseByConversation[key];
    const subscriptionMatches = subscribed?.id === ref.id && subscribed.origin === ref.origin;
    const subscriptionPending = !subscribed && Boolean(opening);
    if (
      initial.protocolByConversation[key] !== 'v2' ||
      !initial.v2Projections[key] ||
      (initial.conversationOwnersByConversation[key]?.length ?? 0) === 0 ||
      (!subscriptionMatches && !subscriptionPending)
    ) {
      return Promise.resolve();
    }

    const task = (async () => {
      if (!subscribed) {
        if (!opening) return;
        await opening;
        const opened = get();
        const openedSubscription = opened.subscribedV2Conversations[key];
        if (
          opened.openGenerationByConversation[key] !== generation ||
          opened.projectionEpochByConversation[key] !== epoch ||
          opened.protocolByConversation[key] !== 'v2' ||
          (opened.conversationOwnersByConversation[key]?.length ?? 0) === 0 ||
          openedSubscription?.id !== ref.id ||
          openedSubscription.origin !== ref.origin
        ) {
          return;
        }
      }
      const result = await window.api.chatGetInitialState(ref);
      const current = get();
      const currentSubscribed = current.subscribedV2Conversations[key];
      if (
        current.openGenerationByConversation[key] !== generation ||
        current.projectionEpochByConversation[key] !== epoch ||
        current.protocolByConversation[key] !== 'v2' ||
        (current.conversationOwnersByConversation[key]?.length ?? 0) === 0 ||
        !currentSubscribed ||
        currentSubscribed.id !== ref.id ||
        currentSubscribed.origin !== ref.origin
      ) {
        return;
      }
      if (result.protocol !== 'v2') throw protocolMismatch('v2', result.protocol);
      if (result.bootstrap.v2ThroughSeq < current.v2Projections[key].lastAppliedV2Seq) return;
      installV2Bootstrap(ref, result.bootstrap);
      await window.api.chatSubscribeV2(ref, result.bootstrap.v2ThroughSeq);
    })();
    const refresh = { openGeneration: generation, projectionEpoch: epoch, task };
    refreshPromiseByConversation.set(key, refresh);
    void task.then(
      () => {
        if (refreshPromiseByConversation.get(key) === refresh) {
          refreshPromiseByConversation.delete(key);
        }
      },
      () => {
        if (refreshPromiseByConversation.get(key) === refresh) {
          refreshPromiseByConversation.delete(key);
        }
      },
    );
    return task;
  };

  const assertCurrentV2Operation = (
    key: ConversationKey,
    openGeneration: number,
    projectionEpoch: number,
  ): void => {
    const current = get();
    if (
      current.protocolByConversation[key] !== 'v2' ||
      current.openGenerationByConversation[key] !== openGeneration ||
      current.projectionEpochByConversation[key] !== projectionEpoch ||
      (current.conversationOwnersByConversation[key]?.length ?? 0) === 0
    ) {
      throw new ConversationChatSupersededError();
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
      const lookupSelectionGeneration = get().mainChatSelectionGeneration;
      const lookupSurfaceGeneration = get().mainChatSurfaceGeneration;
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
          const current = get();
          if (
            current.mainChatSelectionGeneration === lookupSelectionGeneration &&
            current.mainChatSurfaceGeneration === lookupSurfaceGeneration
          ) {
            set({ conversationError: 'Conversation not found' });
          }
          return null;
        }
        handleApiError(error);
        throw error;
      }
    },

    async ensureMessages(ref) {
      const key = conversationKey(ref);
      if (get().protocolByConversation[key] === 'v2') return;
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
      const initial = get();
      const protocol = initial.protocolByConversation[key] ?? 'v1';
      if (protocol === 'v2') {
        const projection = initial.v2Projections[key];
        const cursor = projection?.nextCursor;
        if (!projection || !cursor) return;
        const generation = initial.openGenerationByConversation[key] ?? 0;
        const epoch = initial.projectionEpochByConversation[key] ?? 0;
        try {
          const result = await window.api.chatGetOlderMessages(ref, cursor);
          const current = get();
          if (
            current.openGenerationByConversation[key] !== generation ||
            current.projectionEpochByConversation[key] !== epoch ||
            current.protocolByConversation[key] !== protocol ||
            (current.conversationOwnersByConversation[key]?.length ?? 0) === 0
          ) {
            return;
          }
          if (result.protocol !== 'v2') throw protocolMismatch('v2', result.protocol);
          set((state) => ({
            v2Projections: {
              ...state.v2Projections,
              [key]: prependV2MessagePage(state.v2Projections[key], result.page),
            },
          }));
        } catch (error) {
          handleApiError(error);
          throw error;
        }
        return;
      }

      const cursor = initial.messageCursor[key];
      if (!cursor) return;
      try {
        const page = await window.api.chatGetMessages(ref, cursor);
        if ((get().protocolByConversation[key] ?? 'v1') !== protocol) return;
        storeMessagePage(ref, page, 'merge');
      } catch (error) {
        handleApiError(error);
        throw error;
      }
    },

    openConversation(ref, ownerId) {
      const key = conversationKey(ref);
      const initial = get();
      const owners = initial.conversationOwnersByConversation[key] ?? [];
      if (!owners.includes(ownerId)) {
        set((state) => ({
          conversationOwnersByConversation: {
            ...state.conversationOwnersByConversation,
            [key]: [...(state.conversationOwnersByConversation[key] ?? []), ownerId],
          },
        }));
      }
      const afterRetain = get();
      const existingOpening = afterRetain.openingPromiseByConversation[key];
      if (existingOpening) return existingOpening;
      if (
        afterRetain.protocolByConversation[key] &&
        (afterRetain.protocolByConversation[key] !== 'v2' ||
          afterRetain.subscribedV2Conversations[key])
      ) {
        return Promise.resolve();
      }

      const generation = (afterRetain.openGenerationByConversation[key] ?? 0) + 1;
      set((state) => ({
        openGenerationByConversation: {
          ...state.openGenerationByConversation,
          [key]: generation,
        },
      }));

      const isCurrent = (): boolean => {
        const state = get();
        return (
          state.openGenerationByConversation[key] === generation &&
          (state.conversationOwnersByConversation[key]?.length ?? 0) > 0
        );
      };
      const initialRequest = window.api.chatGetInitialState(ref);
      const operation = async (): Promise<void> => {
        const initialState = await initialRequest;
        if (!isCurrent()) return;
        if (initialState.protocol === 'v2') {
          installV2Bootstrap(ref, initialState.bootstrap);
          await window.api.chatSubscribeV2(ref, initialState.bootstrap.v2ThroughSeq);
          if (!isCurrent()) return;
          set((state) => ({
            subscribedV2Conversations: {
              ...state.subscribedV2Conversations,
              [key]: ref,
            },
          }));
          return;
        }
        set((state) => ({
          protocolByConversation: { ...state.protocolByConversation, [key]: 'v1' },
          projectionEpochByConversation: {
            ...state.projectionEpochByConversation,
            [key]: (state.projectionEpochByConversation[key] ?? 0) + 1,
          },
        }));
        storeMessagePage(ref, initialState.page, 'replace');
      };
      const task = operation().catch((error) => {
        if (!isCurrent()) return;
        handleApiError(error);
        set({ conversationError: error instanceof Error ? error.message : String(error) });
        throw error;
      });
      set((state) => ({
        openingPromiseByConversation: {
          ...state.openingPromiseByConversation,
          [key]: task,
        },
      }));
      void task.then(
        () => {
          if (get().openingPromiseByConversation[key] === task) {
            set((state) => ({
              openingPromiseByConversation: withoutKey(state.openingPromiseByConversation, key),
            }));
          }
        },
        () => {
          if (get().openingPromiseByConversation[key] === task) {
            set((state) => ({
              openingPromiseByConversation: withoutKey(state.openingPromiseByConversation, key),
            }));
          }
        },
      );
      return task;
    },

    async closeConversation(ref, ownerId) {
      const key = conversationKey(ref);
      const owners = (get().conversationOwnersByConversation[key] ?? []).filter(
        (owner) => owner !== ownerId,
      );
      if (owners.length > 0) {
        set((state) => ({
          conversationOwnersByConversation: {
            ...state.conversationOwnersByConversation,
            [key]: owners,
          },
        }));
        return;
      }
      const previous = get();
      if (!(previous.conversationOwnersByConversation[key] ?? []).includes(ownerId)) return;
      const shouldUnsubscribe =
        previous.protocolByConversation[key] === 'v2' ||
        (!previous.protocolByConversation[key] &&
          Boolean(previous.openingPromiseByConversation[key]));
      set((state) => ({
        conversationOwnersByConversation: withoutKey(state.conversationOwnersByConversation, key),
        openGenerationByConversation: {
          ...state.openGenerationByConversation,
          [key]: (state.openGenerationByConversation[key] ?? 0) + 1,
        },
        openingPromiseByConversation: withoutKey(state.openingPromiseByConversation, key),
        subscribedV2Conversations: withoutKey(state.subscribedV2Conversations, key),
        pendingV2LegacyCommandsByConversation: withoutKey(
          state.pendingV2LegacyCommandsByConversation,
          key,
        ),
        commandIssuesByConversation: withoutKey(state.commandIssuesByConversation, key),
        answerAttemptsByConversation: withoutKey(state.answerAttemptsByConversation, key),
      }));
      if (ref.origin === 'gateway' && shouldUnsubscribe) {
        await window.api.chatUnsubscribeV2(ref);
      }
    },

    reserveMainChatSelection() {
      const selectionGeneration = get().mainChatSelectionGeneration + 1;
      const surfaceGeneration = get().mainChatSurfaceGeneration;
      set({ mainChatSelectionGeneration: selectionGeneration });
      return { surfaceGeneration, selectionGeneration };
    },

    async selectConversation(ref, reservation) {
      const intent = reservation ?? get().reserveMainChatSelection();
      const conversation = await get().ensureConversation(ref);
      const afterLookup = get();
      if (
        afterLookup.mainChatSelectionGeneration !== intent.selectionGeneration ||
        afterLookup.mainChatSurfaceGeneration !== intent.surfaceGeneration
      ) {
        return;
      }
      if (!conversation) {
        set({ conversationError: 'Conversation not found' });
        return;
      }
      const key = conversationKey(ref);
      const previousRef = afterLookup.selectedConversationRef;
      const unread = new Set(afterLookup.unreadConversations);
      unread.delete(key);
      set((state) => ({
        selectedConversationRef: ref,
        openTabKeys: state.openTabKeys.includes(key)
          ? state.openTabKeys
          : [...state.openTabKeys, key],
        unreadConversations: unread,
        conversationError: null,
      }));
      if (afterLookup.mainChatSurfaceActive) {
        const opening = get().openConversation(ref, 'main-chat');
        const closing =
          previousRef && conversationKey(previousRef) !== key
            ? get().closeConversation(previousRef, 'main-chat')
            : Promise.resolve();
        await Promise.all([opening, closing]);
        return;
      }
      await get().ensureMessages(ref);
    },

    retainMainChatSurface() {
      const surfaceGeneration = get().mainChatSurfaceGeneration + 1;
      const selectionGeneration = get().mainChatSelectionGeneration + 1;
      const selected = get().selectedConversationRef;
      set({
        mainChatSurfaceGeneration: surfaceGeneration,
        mainChatSelectionGeneration: selectionGeneration,
        mainChatSurfaceActive: true,
      });
      if (selected) {
        void get()
          .openConversation(selected, 'main-chat')
          .catch(() => undefined);
      }
      return () => {
        const current = get();
        if (current.mainChatSurfaceGeneration !== surfaceGeneration) return;
        const currentSelected = current.selectedConversationRef;
        set({
          mainChatSurfaceGeneration: surfaceGeneration + 1,
          mainChatSelectionGeneration: current.mainChatSelectionGeneration + 1,
          mainChatSurfaceActive: false,
        });
        if (currentSelected) {
          void get()
            .closeConversation(currentSelected, 'main-chat')
            .catch(() => undefined);
        }
      };
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
      const before = get();
      const openTabKeys = before.openTabKeys.filter((tab) => tab !== key);
      const closingRef = conversationRefFromKey(key);
      const wasSelected = Boolean(
        before.selectedConversationRef && conversationKey(before.selectedConversationRef) === key,
      );
      if (!wasSelected) {
        set({ openTabKeys });
        return;
      }
      const reservation = get().reserveMainChatSelection();
      const replacement = selectedAfterRemoval(before, key, openTabKeys);
      set({ openTabKeys, selectedConversationRef: replacement });
      if (!before.mainChatSurfaceActive) return;
      void get()
        .closeConversation(closingRef, 'main-chat')
        .catch(() => undefined);
      if (
        replacement &&
        get().mainChatSurfaceGeneration === reservation.surfaceGeneration &&
        get().mainChatSelectionGeneration === reservation.selectionGeneration
      ) {
        void get()
          .openConversation(replacement, 'main-chat')
          .catch(() => undefined);
      }
    },

    async createConversation(agentId, reservation) {
      const intent = reservation ?? get().reserveMainChatSelection();
      if (!get().gatewayOnline || get().conversationAuthority === 'unresolved') {
        throw new Error('Gateway offline — cached conversations are read-only');
      }
      const requestId = crypto.randomUUID();
      const conversation = await window.api.chatCreateConversation(agentId, requestId);
      const ref = refFor(conversation);
      const key = conversationKey(ref);
      set((state) => ({
        conversations: mergeConversations(state.conversations, [conversation]),
        messages: { ...state.messages, [key]: [] },
        messageCursor: { ...state.messageCursor, [key]: null },
        throughSeq: { ...state.throughSeq, [key]: 0 },
        conversationError: null,
      }));
      await get().selectConversation(ref, intent);
      return conversation;
    },

    async renameConversation(ref, title) {
      const { source } = assertMutable(ref);
      try {
        const updated = await window.api.chatRenameConversation(
          ref,
          source.summary.revision,
          title,
        );
        reconcileAuthoritativeConversation(updated);
      } catch (error) {
        const apiError = mobileError(error);
        if (apiError?.code === 'revision_conflict') {
          const current = apiError.details?.current;
          if (current && typeof current === 'object') {
            reconcileRevisionConflict(ref, current as Record<string, unknown>);
          }
        }
        handleApiError(error);
        throw error;
      }
    },

    async deleteConversation(ref) {
      const { source } = assertMutable(ref);
      try {
        await window.api.chatDeleteConversation(ref, source.summary.revision);
        purgeConversation(ref);
      } catch (error) {
        const apiError = mobileError(error);
        if (apiError?.code === 'revision_conflict') {
          const current = apiError.details?.current;
          if (current && typeof current === 'object') {
            reconcileRevisionConflict(ref, current as Record<string, unknown>);
          }
        }
        handleApiError(error);
        throw error;
      }
    },

    async sendMessage(ref, text, images, draftRevision = 0) {
      const { conversation } = assertMutable(ref);
      const key = conversationKey(ref);
      const protocol = get().protocolByConversation[key] ?? 'v1';
      const turnId = crypto.randomUUID();
      const now = new Date().toISOString();
      if (protocol === 'v2') {
        const projection = get().v2Projections[key];
        if (!projection) throw new Error('Conversation v2 projection is unavailable');
        if (projection.queuePaused) {
          throw new Error('Follow Ups paused. Resume or remove them before sending.');
        }
        const openGeneration = get().openGenerationByConversation[key] ?? 0;
        const epoch = get().projectionEpochByConversation[key] ?? 0;
        const intent: V2OrdinarySendIntent = {
          turnId,
          text,
          ...(images?.length ? { images: copiedImages(images) } : {}),
          submittedAt: now,
          draftRevision,
        };
        const optimistic = {
          id: `optimistic:${turnId}`,
          conversationId: ref.id,
          turnId,
          runId: turnId,
          segmentIndex: 0,
          deliveryKind: 'normal' as const,
          ordinal: Number.MAX_SAFE_INTEGER,
          role: 'user' as const,
          status: 'accepted' as const,
          content: {
            type: 'user' as const,
            text,
            ...(images?.length ? { images: copiedImages(images) } : {}),
          },
          createdAt: now,
          updatedAt: now,
        };
        set((state) => ({
          v2Projections: {
            ...state.v2Projections,
            [key]: {
              ...state.v2Projections[key],
              messages: {
                ...state.v2Projections[key].messages,
                [optimistic.id]: optimistic,
              },
              timeline: [
                ...state.v2Projections[key].timeline,
                { kind: 'message' as const, messageId: optimistic.id },
              ],
            },
          },
          ordinarySendIntentsByConversation: {
            ...state.ordinarySendIntentsByConversation,
            [key]: {
              ...(state.ordinarySendIntentsByConversation[key] ?? {}),
              [turnId]: intent,
            },
          },
          localTurnIds: { ...state.localTurnIds, [key]: turnId },
          sending: { ...state.sending, [key]: true },
        }));

        const accepted = await window.api.chatSend(ref, turnId, text, copiedImages(images));
        assertCurrentV2Operation(key, openGeneration, epoch);
        const current = get();
        if (!accepted) throw protocolMismatch('v2', 'undefined');
        if (accepted.protocol !== 'v2') throw protocolMismatch('v2', accepted.protocol);
        const reconciled = reconcileV2Accepted(
          current.v2Projections[key],
          accepted.frame,
          current.ordinarySendIntentsByConversation[key]?.[turnId],
        );
        set((state) => {
          const intents = { ...(state.ordinarySendIntentsByConversation[key] ?? {}) };
          delete intents[turnId];
          const issue = state.commandIssuesByConversation[key];
          return {
            v2Projections: {
              ...state.v2Projections,
              [key]: reconciled.state,
            },
            ordinarySendIntentsByConversation: {
              ...state.ordinarySendIntentsByConversation,
              [key]: intents,
            },
            commandIssuesByConversation:
              issue?.commandId === accepted.frame.id
                ? withoutKey(state.commandIssuesByConversation, key)
                : state.commandIssuesByConversation,
          };
        });
        if (reconciled.needsBootstrap) await refreshV2Projection(ref);
        return;
      }

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
        if (!accepted) {
          if (ref.origin !== 'local') throw protocolMismatch('v1', 'undefined');
        } else if (accepted.protocol !== 'v1') {
          throw protocolMismatch('v1', accepted.protocol);
        } else {
          await get().applyFrame(accepted.frame);
        }
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

    async enqueueInput(ref, input) {
      const key = conversationKey(ref);
      const source = conversationSourceFor(get(), ref);
      if (source?.protocol !== 'v2') throw new Error('Conversation input queue unavailable');
      if (input.behavior === 'steer' && !source.summary.activeTurnId) {
        throw new Error('The response ended before this Steer could be sent');
      }
      const commandId = crypto.randomUUID();
      const inputId = crypto.randomUUID();
      const openGeneration = get().openGenerationByConversation[key] ?? 0;
      const projectionEpoch = get().projectionEpochByConversation[key] ?? 0;
      try {
        const frame = await window.api.chatEnqueueInput(ref, {
          commandId,
          inputId,
          behavior: input.behavior,
          ...(input.behavior === 'steer' && source.summary.activeTurnId
            ? { expectedActiveTurnId: source.summary.activeTurnId }
            : {}),
          text: input.text,
          ...(input.images?.length ? { images: copiedImages(input.images) } : {}),
        });
        assertCurrentV2Operation(key, openGeneration, projectionEpoch);
        await get().applyV2Frame(frame);
        set((state) => ({
          commandIssuesByConversation:
            state.commandIssuesByConversation[key]?.commandId === frame.id
              ? withoutKey(state.commandIssuesByConversation, key)
              : state.commandIssuesByConversation,
        }));
        return frame.input;
      } catch (error) {
        if (isRevisionConflict(error)) await refreshV2Projection(ref);
        throw error;
      }
    },

    async editFollowUp(ref, inputId, expectedRevision, text, images) {
      const key = conversationKey(ref);
      if (get().protocolByConversation[key] !== 'v2') {
        throw new Error('Conversation input queue unavailable');
      }
      const openGeneration = get().openGenerationByConversation[key] ?? 0;
      const projectionEpoch = get().projectionEpochByConversation[key] ?? 0;
      try {
        const frame = await window.api.chatEditFollowUp(ref, {
          commandId: crypto.randomUUID(),
          inputId,
          expectedRevision,
          text,
          ...(images?.length ? { images: copiedImages(images) } : {}),
        });
        assertCurrentV2Operation(key, openGeneration, projectionEpoch);
        await get().applyV2Frame(frame);
        set((state) => ({
          commandIssuesByConversation:
            state.commandIssuesByConversation[key]?.commandId === frame.id
              ? withoutKey(state.commandIssuesByConversation, key)
              : state.commandIssuesByConversation,
        }));
        return frame.input;
      } catch (error) {
        if (isRevisionConflict(error)) await refreshV2Projection(ref);
        throw error;
      }
    },

    async removeFollowUp(ref, inputId, expectedRevision) {
      const key = conversationKey(ref);
      if (get().protocolByConversation[key] !== 'v2') {
        throw new Error('Conversation input queue unavailable');
      }
      const openGeneration = get().openGenerationByConversation[key] ?? 0;
      const projectionEpoch = get().projectionEpochByConversation[key] ?? 0;
      try {
        const frame = await window.api.chatRemoveFollowUp(
          ref,
          crypto.randomUUID(),
          inputId,
          expectedRevision,
        );
        assertCurrentV2Operation(key, openGeneration, projectionEpoch);
        await get().applyV2Frame(frame);
        set((state) => ({
          commandIssuesByConversation:
            state.commandIssuesByConversation[key]?.commandId === frame.id
              ? withoutKey(state.commandIssuesByConversation, key)
              : state.commandIssuesByConversation,
        }));
      } catch (error) {
        if (isRevisionConflict(error)) await refreshV2Projection(ref);
        throw error;
      }
    },

    async resumeFollowUps(ref) {
      const key = conversationKey(ref);
      const projection = get().v2Projections[key];
      if (get().protocolByConversation[key] !== 'v2' || !projection) {
        throw new Error('Conversation input queue unavailable');
      }
      const openGeneration = get().openGenerationByConversation[key] ?? 0;
      const projectionEpoch = get().projectionEpochByConversation[key] ?? 0;
      try {
        const frame = await window.api.chatResumeFollowUps(
          ref,
          crypto.randomUUID(),
          projection.queueRevision,
        );
        assertCurrentV2Operation(key, openGeneration, projectionEpoch);
        await get().applyV2Frame(frame);
        set((state) => ({
          commandIssuesByConversation:
            state.commandIssuesByConversation[key]?.commandId === frame.id
              ? withoutKey(state.commandIssuesByConversation, key)
              : state.commandIssuesByConversation,
        }));
      } catch (error) {
        if (isRevisionConflict(error)) await refreshV2Projection(ref);
        throw error;
      }
    },

    cancelMessage(ref) {
      const key = conversationKey(ref);
      const source = conversationSourceFor(get(), ref);
      const turnId = source?.summary.activeTurnId ?? get().localTurnIds[key];
      if (!source || !turnId) return;
      const localDispatchToken = crypto.randomUUID();
      if (source.protocol === 'v2') {
        const command: PendingV2LegacyCommand = {
          localDispatchToken,
          wireCommandId: turnId,
          runId: turnId,
          kind: 'cancel',
        };
        set((state) => ({
          pendingV2LegacyCommandsByConversation: {
            ...state.pendingV2LegacyCommandsByConversation,
            [key]: {
              ...(state.pendingV2LegacyCommandsByConversation[key] ?? {}),
              [localDispatchToken]: command,
            },
          },
        }));
      }
      window.api.chatCancel(ref, turnId, localDispatchToken);
      if (source.protocol === 'v1') {
        set((state) => ({ sending: { ...state.sending, [key]: false } }));
      }
    },

    answerQuestion(ref, questionId, answer) {
      const key = conversationKey(ref);
      const conversation = exactConversation(ref);
      const source = conversationSourceFor(get(), ref);
      if (
        !conversation ||
        !source ||
        conversation.offline ||
        conversation.readOnly ||
        !get().gatewayOnline
      ) {
        throw new Error('This conversation is read-only');
      }
      const turnId = source.summary.activeTurnId ?? get().localTurnIds[key];
      if (!turnId) throw new Error('Conversation does not have an active turn');
      const localDispatchToken = crypto.randomUUID();
      if (source.protocol === 'v2') {
        const command: PendingV2LegacyCommand = {
          localDispatchToken,
          wireCommandId: turnId,
          runId: turnId,
          kind: 'answer',
          questionId,
        };
        set((state) => ({
          pendingV2LegacyCommandsByConversation: {
            ...state.pendingV2LegacyCommandsByConversation,
            [key]: {
              ...(state.pendingV2LegacyCommandsByConversation[key] ?? {}),
              [localDispatchToken]: command,
            },
          },
          answerAttemptsByConversation: {
            ...state.answerAttemptsByConversation,
            [key]: {
              ...(state.answerAttemptsByConversation[key] ?? {}),
              [questionId]: { runId: turnId, questionId, answer, state: 'pending' },
            },
          },
        }));
      }
      window.api.chatAnswerQuestion(ref, turnId, questionId, answer, localDispatchToken);
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

    async applyV2Frame(frame) {
      if (!('conversationId' in frame) || !frame.conversationId) return;
      const ref = { id: frame.conversationId, origin: 'gateway' as const };
      const key = conversationKey(ref);
      const current = get();
      const projection = current.v2Projections[key];
      if (
        current.protocolByConversation[key] !== 'v2' ||
        !projection ||
        (current.conversationOwnersByConversation[key]?.length ?? 0) === 0
      ) {
        return;
      }

      let applied: { state: V2ConversationProjection; gapAfter: number | null };
      let remoteAccepted = false;
      if (frame.type === 'accepted') {
        if (frame.v2Seq > projection.lastAppliedV2Seq + 1) {
          await refreshV2Projection(ref);
          return;
        }
        const intent = current.ordinarySendIntentsByConversation[key]?.[frame.runId];
        const reconciled = reconcileV2Accepted(projection, frame, intent);
        applied = { state: reconciled.state, gapAfter: null };
        remoteAccepted = reconciled.needsBootstrap;
      } else {
        applied = applyV2ProjectionFrame(projection, frame);
      }
      if (applied.gapAfter !== null) {
        await refreshV2Projection(ref);
        return;
      }
      if (applied.state === projection) return;

      const terminal = frame.type === 'done' || frame.type === 'error';
      set((state) => {
        let attempts = state.answerAttemptsByConversation[key] ?? {};
        let commands = state.pendingV2LegacyCommandsByConversation[key] ?? {};
        if (frame.type === 'accepted') {
          attempts = reconcileAnswerAttempts(attempts, frame.runId);
          commands = Object.fromEntries(
            Object.entries(commands).filter(([, command]) => command.runId === frame.runId),
          );
        }
        if (terminal) {
          attempts = Object.fromEntries(
            Object.entries(attempts).map(([questionId, attempt]) => [
              questionId,
              attempt.runId === frame.runId ? { ...attempt, state: 'ended' as const } : attempt,
            ]),
          );
          commands = Object.fromEntries(
            Object.entries(commands).filter(([, command]) => command.runId !== frame.runId),
          );
        }
        return {
          v2Projections: { ...state.v2Projections, [key]: applied.state },
          answerAttemptsByConversation: {
            ...state.answerAttemptsByConversation,
            [key]: attempts,
          },
          pendingV2LegacyCommandsByConversation: {
            ...state.pendingV2LegacyCommandsByConversation,
            [key]: commands,
          },
          localTurnIds:
            terminal && state.localTurnIds[key] === frame.runId
              ? { ...state.localTurnIds, [key]: undefined }
              : state.localTurnIds,
          sending:
            terminal && state.localTurnIds[key] === frame.runId
              ? { ...state.sending, [key]: false }
              : state.sending,
        };
      });
      if (remoteAccepted) await refreshV2Projection(ref);
    },

    handleV2CommandIssue(issue) {
      const key = conversationKey(issue.conversation);
      const state = get();
      const projection = state.v2Projections[key];
      const ownersPresent = (state.conversationOwnersByConversation[key]?.length ?? 0) > 0;
      const subscribed = state.subscribedV2Conversations[key];
      const liveSubscription = Boolean(
        ownersPresent &&
          subscribed &&
          subscribed.id === issue.conversation.id &&
          subscribed.origin === issue.conversation.origin,
      );
      const command = state.pendingV2LegacyCommandsByConversation[key]?.[issue.localDispatchToken];
      const exactCommand = Boolean(
        command &&
          command.localDispatchToken === issue.localDispatchToken &&
          command.wireCommandId === issue.commandId &&
          command.kind === issue.kind &&
          (!command.questionId || command.questionId === issue.questionId),
      );
      if (
        state.protocolByConversation[key] !== 'v2' ||
        !projection ||
        !ownersPresent ||
        (!exactCommand &&
          (!liveSubscription || projection.conversation.activeTurnId !== issue.commandId))
      ) {
        return;
      }

      let attempts = state.answerAttemptsByConversation[key] ?? {};
      if (issue.kind === 'answer') {
        const questionId = issue.questionId ?? command?.questionId;
        const exactAttempt = questionId ? attempts[questionId] : undefined;
        if (
          questionId &&
          exactAttempt?.runId === issue.commandId &&
          exactAttempt.state === 'pending'
        ) {
          attempts = {
            ...attempts,
            [questionId]: { ...exactAttempt, state: 'rejected' },
          };
        } else if (issue.ambiguousCorrelation) {
          const candidates = Object.values(attempts).filter(
            (attempt) => attempt.runId === issue.commandId && attempt.state === 'pending',
          );
          if (candidates.length === 1) {
            const [candidate] = candidates;
            attempts = {
              ...attempts,
              [candidate.questionId]: { ...candidate, state: 'rejected' },
            };
          }
        }
      }
      set((current) => ({
        commandIssuesByConversation: {
          ...current.commandIssuesByConversation,
          [key]: issue,
        },
        answerAttemptsByConversation: {
          ...current.answerAttemptsByConversation,
          [key]: attempts,
        },
      }));
    },

    clearCommandIssue(ref) {
      const key = conversationKey(ref);
      set((state) => ({
        commandIssuesByConversation: withoutKey(state.commandIssuesByConversation, key),
      }));
    },

    handleConnectionIssue(issue) {
      set({ connectionIssue: issue, conversationError: issue.message });
    },

    async invalidateConversation(event) {
      const ref = event.conversation;
      if (ref.origin === 'gateway' && ref.id === '*') {
        await get().loadConversations();
        return;
      }
      const key = conversationKey(ref);
      const atInvocation = get();
      const selected = atInvocation.selectedConversationRef;
      const reservation =
        selected && conversationKey(selected) === key
          ? get().reserveMainChatSelection()
          : undefined;
      const selectionGuard = reservation ?? {
        surfaceGeneration: atInvocation.mainChatSurfaceGeneration,
        selectionGeneration: atInvocation.mainChatSelectionGeneration,
      };
      if (event.type === 'deleted') {
        purgeConversation(ref, reservation);
        return;
      }
      const invalidationIsStale = (): boolean => !selectionReservationIsCurrent(selectionGuard);
      try {
        const conversation = await window.api.chatGetConversation(ref);
        if (invalidationIsStale()) return;
        if (!conversation || conversation.status === 'deleted') {
          purgeConversation(ref, reservation);
          return;
        }
        reconcileAuthoritativeConversation(conversation);
        if (
          get().protocolByConversation[key] === 'v2' &&
          (get().conversationOwnersByConversation[key]?.length ?? 0) > 0
        ) {
          await refreshV2Projection(ref);
          return;
        }
        if (conversation.activeTurnId) {
          const page = await window.api.chatGetMessages(ref, undefined);
          storeMessagePage(ref, page, 'merge');
        }
      } catch (error) {
        if (invalidationIsStale()) return;
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
  window.api.onChatV2Frame((frame) => {
    void useChatStore
      .getState()
      .applyV2Frame(frame)
      .catch(() => undefined);
  });
  window.api.onChatV2CommandError((issue) => {
    useChatStore.getState().handleV2CommandIssue(issue);
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
