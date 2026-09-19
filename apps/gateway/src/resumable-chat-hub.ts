import type {
  ConversationKind,
  ConversationMessageOrigin,
  ConversationQueueSnapshot,
  MobileWsClientFrame,
  MobileWsServerFrame,
} from '@dash/mobile-contract';
import { toClientLocation } from './client-location.js';
import {
  type AcceptedTurn,
  type ConversationService,
  ConversationServiceError,
  type PersistedTurnFrame,
} from './conversation-service.js';
import type { EventLogEntry } from './event-log-store.js';
import type {
  ExecutionCoordinator,
  ExecutionTurn,
  StartSystemTurnInput,
  TurnObserver,
} from './execution-coordinator.js';
export type {
  ObservedTurn,
  StartSystemTurnInput,
  TurnObserver,
  TurnOutcome,
} from './execution-coordinator.js';

export type ResumableSendFrame = Extract<MobileWsClientFrame, { type: 'message' }> & {
  resumable: true;
};
export type ResumeFrame = Extract<MobileWsClientFrame, { type: 'resume' }>;
export type WatchFrame = Extract<MobileWsClientFrame, { type: 'watch' }>;
export type FollowUpFrame = Extract<MobileWsClientFrame, { type: 'follow_up' }>;
export type InterruptAndSendFrame = Extract<MobileWsClientFrame, { type: 'interrupt_and_send' }>;
export type StopConversationFrame = Extract<MobileWsClientFrame, { type: 'stop_conversation' }>;
export type ResumePendingFrame = Extract<MobileWsClientFrame, { type: 'resume_pending' }>;
export type EditPendingFrame = Extract<MobileWsClientFrame, { type: 'edit_pending' }>;
export type RemovePendingFrame = Extract<MobileWsClientFrame, { type: 'remove_pending' }>;

export interface TurnFrameSink {
  send(frame: MobileWsServerFrame): void;
}

export interface ResumableChatHubOptions {
  conversations: ConversationService;
  execution: ExecutionCoordinator;
}

export interface ResumableChatHub {
  start(frame: ResumableSendFrame, sink: TurnFrameSink): void;
  resume(frame: ResumeFrame, sink: TurnFrameSink): void;
  watch(frame: WatchFrame, sink: TurnFrameSink): void;
  followUp(frame: FollowUpFrame, sink: TurnFrameSink): void;
  interruptAndSend(frame: InterruptAndSendFrame, sink: TurnFrameSink): void;
  stopConversation(frame: StopConversationFrame, sink: TurnFrameSink): void;
  resumePending(frame: ResumePendingFrame, sink: TurnFrameSink): void;
  editPending(frame: EditPendingFrame, sink: TurnFrameSink): void;
  removePending(frame: RemovePendingFrame, sink: TurnFrameSink): void;
  answer(turnId: string, questionId: string, answer: string): Promise<void>;
  cancel(turnId: string, sink: TurnFrameSink): Promise<void>;
  detach(sink: TurnFrameSink): void;
  /**
   * Watch a conversation rather than a single turn, so this sink receives
   * turns it did not start — server-initiated notifications and child turns.
   * `start` and `resume` do this implicitly for their own sink. Throws
   * `ConversationServiceError('not_found')` for an unknown or foreign
   * conversation, exactly as `resume` does, so the subscription table only
   * ever holds keys that can actually produce a turn.
   */
  subscribe(agentId: string, conversationId: string, sink: TurnFrameSink): void;
  /** Always succeeds, including for a conversation that has since been deleted. */
  unsubscribe(agentId: string, conversationId: string, sink: TurnFrameSink): void;
  /**
   * Start a turn nobody asked for over the wire. Runs the same accept →
   * stream → finish path as `start`, with no initial sink: only conversation
   * subscribers see it. Throws `ConversationServiceError('conversation_busy')`
   * when the conversation already holds a turn lease — that 409 is the signal
   * to queue the notification and retry on the next `finishTurn`, not an
   * error to swallow.
   */
  startSystemTurn(input: StartSystemTurnInput): { turnId: string };
  /** Returns a disposer that removes the observer. */
  addObserver(observer: TurnObserver): () => void;
  cancelAgent(agentId: string): Promise<void>;
  allowAgent(agentId: string): void;
  /** Detach this adapter without cancelling execution. */
  dispose(): void;
  stop(): Promise<void>;
}

function conversationKey(agentId: string, conversationId: string): string {
  return `${agentId}/${conversationId}`;
}

function frameFromEntry(entry: EventLogEntry): MobileWsServerFrame {
  const common = { id: entry.msgId, conversationId: entry.conversationId, seq: entry.seq };
  switch (entry.payload.type) {
    case 'accepted':
      return {
        type: 'accepted',
        ...common,
        userMessageId: entry.payload.userMessageId,
        assistantMessageId: entry.payload.assistantMessageId,
        revision: entry.payload.revision,
        ...(entry.payload.pendingItemId ? { pendingItemId: entry.payload.pendingItemId } : {}),
      };
    case 'event':
      return { type: 'event', ...common, event: entry.payload.event };
    case 'done':
      return { type: 'done', ...common, outcome: entry.payload.outcome ?? 'completed' };
    case 'error':
      return {
        type: 'error',
        ...common,
        error: entry.payload.error,
        code: entry.payload.code,
        retryable: entry.payload.retryable,
      };
  }
}

function frameFromPersisted(
  live: ExecutionTurn,
  persisted: PersistedTurnFrame,
): MobileWsServerFrame {
  return frameFromEntry({
    seq: persisted.seq,
    msgId: live.turnId,
    agentId: live.agentId,
    conversationId: live.conversationId,
    timestamp: '',
    payload: persisted.payload,
  });
}

/**
 * `origin`/`kind` ride the accepted frame only when the turn is NOT an
 * ordinary user turn on a user conversation. An existing client that never
 * subscribes and never receives a server-initiated turn therefore sees the
 * exact bytes it saw before subscriptions existed; on the wire both fields
 * are optional and absent means `'user'` (spec 7.6).
 */
function frameFromAccepted(
  frame: Pick<ResumableSendFrame, 'id' | 'conversationId'>,
  accepted: AcceptedTurn,
  origin: ConversationMessageOrigin,
  kind: ConversationKind,
  requestId?: string,
  includeOrdinaryMetadata = false,
): MobileWsServerFrame {
  const ordinary = origin === 'user' && kind === 'user';
  return {
    type: 'accepted',
    id: frame.id,
    conversationId: frame.conversationId,
    userMessageId: accepted.userMessage.id,
    assistantMessageId: accepted.assistantMessage.id,
    revision: accepted.revision,
    seq: accepted.seq,
    ...(ordinary && !includeOrdinaryMetadata ? {} : { origin, kind }),
    // Spread, never `requestId: undefined`: `ChatAccepted` is
    // `additionalProperties: false` and a present-but-undefined key would
    // serialise away over JSON but still show up to an in-process sink.
    ...(requestId !== undefined ? { requestId } : {}),
    ...(accepted.pendingItemId ? { pendingItemId: accepted.pendingItemId } : {}),
  };
}

export function createResumableChatHub(options: ResumableChatHubOptions): ResumableChatHub {
  const { conversations, execution } = options;
  const turnSubscribers = new Map<string, Set<TurnFrameSink>>();
  const conversationSubscribers = new Map<string, Set<TurnFrameSink>>();
  const conversationWatchers = new Map<string, Set<TurnFrameSink>>();
  const commandSinks = new Map<string, TurnFrameSink[]>();
  const assertAccepting = () => execution.assertAccepting();
  const sinksForTurn = (turnId: string): Set<TurnFrameSink> => {
    let sinks = turnSubscribers.get(turnId);
    if (!sinks) {
      sinks = new Set();
      turnSubscribers.set(turnId, sinks);
    }
    return sinks;
  };
  const assertOwnedConversation = (agentId: string, conversationId: string): void => {
    const conversation = conversations.get(conversationId);
    if (!conversation || conversation.agentId !== agentId) {
      throw new ConversationServiceError('not_found', 'Conversation not found', 404, false);
    }
  };

  const detachSink = (sink: TurnFrameSink): void => {
    for (const sinks of turnSubscribers.values()) sinks.delete(sink);
    // Conversation subscriptions outlive any single turn, so a closed socket
    // that is only dropped from live turns would keep being written to for
    // every future turn on that conversation.
    for (const [key, sinks] of conversationSubscribers) {
      if (!sinks.delete(sink)) continue;
      if (sinks.size === 0) conversationSubscribers.delete(key);
    }
    for (const [key, sinks] of conversationWatchers) {
      if (!sinks.delete(sink)) continue;
      if (sinks.size === 0) conversationWatchers.delete(key);
    }
  };

  const send = (sink: TurnFrameSink, frame: MobileWsServerFrame): boolean => {
    try {
      sink.send(frame);
      return true;
    } catch {
      detachSink(sink);
      return false;
    }
  };

  const addConversationSubscriber = (key: string, sink: TurnFrameSink): void => {
    const existing = conversationSubscribers.get(key);
    if (existing) existing.add(sink);
    else conversationSubscribers.set(key, new Set([sink]));
  };

  const removeConversationSubscriber = (key: string, sink: TurnFrameSink): void => {
    const existing = conversationSubscribers.get(key);
    if (!existing?.delete(sink)) return;
    if (existing.size === 0) conversationSubscribers.delete(key);
  };

  const addConversationWatcher = (key: string, sink: TurnFrameSink): void => {
    const existing = conversationWatchers.get(key);
    if (existing) existing.add(sink);
    else conversationWatchers.set(key, new Set([sink]));
  };

  const removeConversationWatcher = (key: string, sink: TurnFrameSink): void => {
    const existing = conversationWatchers.get(key);
    if (!existing?.delete(sink)) return;
    if (existing.size === 0) conversationWatchers.delete(key);
  };

  /**
   * Fan out to the union of the turn's own subscribers and the conversation's
   * subscribers. A sink in both sets is written to exactly once; a sink that
   * throws is dropped from both, because a dead socket is dead for every turn.
   *
   * Conversation subscribers receive ONLY turns they could not have started
   * themselves — server-initiated notification turns and sub-agent child turns.
   * An ordinary user turn stays with its own sink. `message`/`resume`
   * auto-subscribe for the socket's whole lifetime (spec 7.6), so without this
   * gate a second client typing into the same conversation would push its
   * `accepted`/`event`/`done` at every peer that ever touched it — which today
   * makes web overwrite `pending` and iOS append a blank user bubble. Nothing
   * in the sub-agent feature needs that, and it would ship before any client
   * learned to handle a turn it did not start.
   */
  const broadcast = (
    live: ExecutionTurn,
    frame: MobileWsServerFrame,
    watcherFrame: MobileWsServerFrame = frame,
  ): void => {
    const key = conversationKey(live.agentId, live.conversationId);
    const legacySubscribers = live.origin === 'user' ? undefined : conversationSubscribers.get(key);
    const watchers = conversationWatchers.get(key);
    for (const sink of sinksForTurn(live.turnId)) {
      if (send(sink, frame)) continue;
      sinksForTurn(live.turnId).delete(sink);
      removeConversationSubscriber(key, sink);
      removeConversationWatcher(key, sink);
    }
    for (const sink of [...(legacySubscribers ?? [])]) {
      if (sinksForTurn(live.turnId).has(sink)) continue;
      if (send(sink, frame)) continue;
      removeConversationSubscriber(key, sink);
      removeConversationWatcher(key, sink);
    }
    for (const sink of [...(watchers ?? [])]) {
      if (sinksForTurn(live.turnId).has(sink) || legacySubscribers?.has(sink)) continue;
      if (send(sink, watcherFrame)) continue;
      removeConversationSubscriber(key, sink);
      removeConversationWatcher(key, sink);
    }
  };

  const broadcastQueue = (
    agentId: string,
    conversationId: string,
    queue: ConversationQueueSnapshot,
    commandId?: string,
  ): void => {
    const key = conversationKey(agentId, conversationId);
    const watchers = conversationWatchers.get(key);
    if (!watchers) return;
    const frame: MobileWsServerFrame = {
      type: 'queue_changed',
      conversationId,
      queue,
      ...(commandId ? { commandId } : {}),
    };
    for (const sink of [...watchers]) {
      if (send(sink, frame)) continue;
      removeConversationSubscriber(key, sink);
      removeConversationWatcher(key, sink);
    }
  };

  const replay = (
    agentId: string,
    conversationId: string,
    sinceSeq: number,
    sink: TurnFrameSink,
  ): boolean => {
    for (const entry of conversations.eventLog.readSince(agentId, conversationId, sinceSeq)) {
      if (!send(sink, frameFromEntry(entry))) return false;
    }
    return true;
  };

  const attachIfLive = (
    turnId: string,
    agentId: string,
    conversationId: string,
    sink: TurnFrameSink,
  ): void => {
    const conversation = conversations.get(conversationId);
    const live = execution.getLiveTurn(turnId);
    if (
      conversation?.activeTurnId === turnId &&
      live?.agentId === agentId &&
      live.conversationId === conversationId
    ) {
      sinksForTurn(live.turnId).add(sink);
    }
  };

  const acceptedFrame = (
    turn: ExecutionTurn,
    accepted: AcceptedTurn,
    requestId?: string,
    watched = false,
  ): MobileWsServerFrame =>
    frameFromAccepted(
      {
        id: turn.turnId,
        conversationId: turn.conversationId,
      },
      accepted,
      turn.origin,
      turn.kind,
      requestId,
      watched,
    );
  const dispose = execution.subscribe((update) => {
    switch (update.type) {
      case 'accepted':
        broadcast(
          update.turn,
          acceptedFrame(update.turn, update.accepted, update.requestId),
          acceptedFrame(update.turn, update.accepted, update.requestId, true),
        );
        break;
      case 'persisted':
        broadcast(update.turn, frameFromPersisted(update.turn, update.persisted));
        break;
      case 'transient':
        broadcast(update.turn, {
          type: 'event',
          id: update.turn.turnId,
          conversationId: update.turn.conversationId,
          event: update.event,
        });
        break;
      case 'queue':
        broadcastQueue(update.agentId, update.conversationId, update.queue, update.commandId);
        break;
      case 'command': {
        const sinks = commandSinks.get(
          `${conversationKey(update.agentId, update.conversationId)}/${update.receipt.id}`,
        );
        const sink = sinks?.at(-1);
        if (sink) send(sink, update.receipt);
        break;
      }
      case 'settled':
        turnSubscribers.delete(update.turn.turnId);
        break;
    }
  });
  const command = (
    frame: { id: string; agentId: string; conversationId: string },
    sink: TurnFrameSink,
    execute: () => unknown,
  ): void => {
    const key = `${conversationKey(frame.agentId, frame.conversationId)}/${frame.id}`;
    const sinks = commandSinks.get(key) ?? [];
    commandSinks.set(key, sinks);
    sinks.push(sink);
    try {
      execute();
    } finally {
      sinks.pop();
      if (sinks.length === 0) commandSinks.delete(key);
    }
  };
  const hub: ResumableChatHub = {
    start(frame, sink) {
      // Admission publishes synchronously: register first so accepted always
      // precedes provider events, then undo only provisional additions on failure.
      const key = conversationKey(frame.agentId, frame.conversationId);
      const hadConversation = conversationSubscribers.get(key)?.has(sink);
      const hadTurn = turnSubscribers.get(frame.id)?.has(sink);
      sinksForTurn(frame.id).add(sink);
      addConversationSubscriber(key, sink);
      try {
        const accepted = execution.start({
          agentId: frame.agentId,
          conversationId: frame.conversationId,
          turnId: frame.id,
          channelId: frame.channelId,
          text: frame.text,
          images: frame.images,
          location: toClientLocation(frame.location),
          modality: frame.modality,
        });
        if (!accepted.created) {
          // A duplicate is a replay for this requester, never another execution
          // or a broadcast to peers that already saw its accepted event.
          if (!hadTurn) turnSubscribers.get(frame.id)?.delete(sink);
          if (turnSubscribers.get(frame.id)?.size === 0) turnSubscribers.delete(frame.id);
          if (!hadConversation) removeConversationSubscriber(key, sink);
          const turn: ExecutionTurn = {
            agentId: frame.agentId,
            conversationId: frame.conversationId,
            turnId: frame.id,
            origin: 'user',
            kind: accepted.conversation.kind,
          };
          if (!send(sink, acceptedFrame(turn, accepted))) return;
          if (!replay(frame.agentId, frame.conversationId, accepted.seq, sink)) return;
          addConversationSubscriber(key, sink);
          attachIfLive(frame.id, frame.agentId, frame.conversationId, sink);
          if (!execution.getLiveTurn(frame.id)) turnSubscribers.delete(frame.id);
        }
      } catch (error) {
        if (!hadTurn) turnSubscribers.get(frame.id)?.delete(sink);
        if (turnSubscribers.get(frame.id)?.size === 0) turnSubscribers.delete(frame.id);
        if (!hadConversation) removeConversationSubscriber(key, sink);
        throw error;
      }
    },
    startSystemTurn(input) {
      return execution.startSystemTurn(input);
    },
    resume(frame, sink) {
      assertAccepting();
      assertOwnedConversation(frame.agentId, frame.conversationId);
      if (!replay(frame.agentId, frame.conversationId, frame.sinceSeq, sink)) return;
      addConversationSubscriber(conversationKey(frame.agentId, frame.conversationId), sink);
      attachIfLive(frame.id, frame.agentId, frame.conversationId, sink);
    },

    watch(frame, sink) {
      assertAccepting();
      assertOwnedConversation(frame.agentId, frame.conversationId);
      if (!replay(frame.agentId, frame.conversationId, frame.sinceSeq, sink)) return;
      const key = conversationKey(frame.agentId, frame.conversationId);
      addConversationWatcher(key, sink);
      const summary = conversations.get(frame.conversationId);
      if (
        !summary ||
        !send(sink, {
          type: 'watched',
          id: frame.id,
          conversationId: frame.conversationId,
          throughSeq: summary.lastSeq,
          queue: conversations.queueSnapshot(frame.conversationId),
        })
      ) {
        removeConversationWatcher(key, sink);
      }
    },

    followUp(frame, sink) {
      const { id, type: _type, ...input } = frame;
      command(frame, sink, () => execution.followUp({ ...input, commandId: id }));
    },
    interruptAndSend(frame, sink) {
      const { id, type: _type, ...input } = frame;
      command(frame, sink, () => execution.interruptAndSend({ ...input, commandId: id }));
    },
    stopConversation(frame, sink) {
      const { id, type: _type, ...input } = frame;
      command(frame, sink, () => execution.stopConversation({ ...input, commandId: id }));
    },
    resumePending(frame, sink) {
      const { id, type: _type, ...input } = frame;
      command(frame, sink, () => execution.resumePending({ ...input, commandId: id }));
    },
    editPending(frame, sink) {
      const { id, type: _type, ...input } = frame;
      command(frame, sink, () => execution.editPending({ ...input, commandId: id }));
    },
    removePending(frame, sink) {
      const { id, type: _type, ...input } = frame;
      command(frame, sink, () => execution.removePending({ ...input, commandId: id }));
    },
    subscribe(agentId, conversationId, sink) {
      assertAccepting();
      assertOwnedConversation(agentId, conversationId);
      addConversationSubscriber(conversationKey(agentId, conversationId), sink);
    },

    unsubscribe(agentId, conversationId, sink) {
      removeConversationSubscriber(conversationKey(agentId, conversationId), sink);
    },

    addObserver(observer) {
      return execution.addObserver(observer);
    },
    answer(turnId, questionId, answer) {
      return execution.answer(turnId, questionId, answer);
    },
    async cancel(turnId, sink) {
      assertAccepting();
      if (execution.getLiveTurn(turnId)) sinksForTurn(turnId).add(sink);
      await execution.cancel(turnId);
    },
    detach: detachSink,
    cancelAgent(agentId) {
      return execution.cancelAgent(agentId);
    },
    allowAgent(agentId) {
      execution.allowAgent(agentId);
    },
    dispose() {
      dispose();
      turnSubscribers.clear();
      conversationSubscribers.clear();
      conversationWatchers.clear();
      commandSinks.clear();
    },
    async stop() {
      await execution.stop();
      hub.dispose();
    },
  };
  return hub;
}
