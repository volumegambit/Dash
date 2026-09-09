import { randomUUID } from 'node:crypto';
import type { AgentEvent } from '@dash/agent';
import type {
  ConversationKind,
  ConversationMessageOrigin,
  ConversationSummary,
  MobileWsClientFrame,
  MobileWsServerFrame,
} from '@dash/mobile-contract';
import { isTransientAgentEvent } from '@dash/swarm';
import type { AgentChatCoordinator } from './agent-chat-coordinator.js';
import { toClientLocation } from './client-location.js';
import type { ConversationAutoTitleService } from './conversation-auto-title.js';
import {
  type AcceptedTurn,
  type ConversationService,
  ConversationServiceError,
  type PersistedTurnFrame,
} from './conversation-service.js';
import type { EventLogEntry } from './event-log-store.js';
import type { MemorySweepService } from './memory-sweep.js';
import type { SkillReviewService } from './skill-review.js';

export type ResumableSendFrame = Extract<MobileWsClientFrame, { type: 'message' }> & {
  resumable: true;
};
export type ResumeFrame = Extract<MobileWsClientFrame, { type: 'resume' }>;

export interface TurnFrameSink {
  send(frame: MobileWsServerFrame): void;
}

export interface ResumableChatHubOptions {
  conversations: ConversationService;
  agents: AgentChatCoordinator;
  autoTitle: ConversationAutoTitleService;
  /** Optional post-turn memory sweep; scheduled only for turns that complete. */
  memorySweep?: Pick<MemorySweepService, 'schedule'>;
  skillReview?: Pick<SkillReviewService, 'schedule'>;
  swarmCoordinator?: { cancelTurn(agentId: string, conversationId: string): boolean };
  onChanged?(summary: ConversationSummary): void;
}

/** The turn a `TurnObserver` callback is about. */
export interface ObservedTurn {
  agentId: string;
  conversationId: string;
  turnId: string;
}

export type TurnOutcome = 'completed' | 'cancelled' | 'failed';

/**
 * Watches every turn the hub runs. The sub-agent coordinator (design
 * 2026-09-04 sub-agents, 7.1) uses this to track a child's tool-call count,
 * its report, and its terminal state without owning the run.
 *
 * Callbacks are fire-and-forget: a throwing observer is isolated so it can
 * never break the turn it is watching.
 */
export interface TurnObserver {
  onEvent(turn: ObservedTurn, event: AgentEvent): void;
  /**
   * `error` carries the failure text of a `'failed'` turn. `runTurn` throws on
   * an `error` event BEFORE it reaches `onEvent`, so without it an observer
   * would know a turn failed and never learn why — and a sub-agent's report is
   * exactly that text.
   */
  onFinish(turn: ObservedTurn, outcome: TurnOutcome, error?: string): void;
}

export interface StartSystemTurnInput {
  agentId: string;
  conversationId: string;
  text: string;
  /** `'notification'` wakes a parent; `'parent'` is a spawned child's first turn. */
  origin: Exclude<ConversationMessageOrigin, 'user'>;
  /** Supply for an idempotent retry; otherwise one is generated. */
  turnId?: string;
  /**
   * The CLIENT's correlation id for the request that caused this turn, echoed
   * verbatim on the turn's `accepted` frame (`ChatAccepted.requestId`). The
   * server picks the turn id for a sub-agent resume, so this is the only thing
   * that tells a client which of its own in-flight follow-ups a later
   * `accepted` belongs to. Live-only: it is never written to the event log, so
   * a replayed `accepted` never carries it.
   */
  requestId?: string;
}

export interface ResumableChatHub {
  start(frame: ResumableSendFrame, sink: TurnFrameSink): void;
  resume(frame: ResumeFrame, sink: TurnFrameSink): void;
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
  stop(): Promise<void>;
}

function conversationKey(agentId: string, conversationId: string): string {
  return `${agentId}/${conversationId}`;
}

interface LiveTurn {
  turnId: string;
  agentId: string;
  conversationId: string;
  /** Decides conversation fan-out: only a non-`'user'` turn reaches subscribers. */
  origin: ConversationMessageOrigin;
  /**
   * `'subagent'` for a CHILD conversation's turn. Read only by the post-turn
   * work below, which is the parent's, not the child's.
   */
  kind: ConversationKind;
  controller: AbortController;
  subscribers: Set<TurnFrameSink>;
  cancelled: boolean;
  terminal: boolean;
  settled: boolean;
  /** One `onFinish` per turn, whichever path gets there first. */
  finishNotified: boolean;
  promise: Promise<void>;
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

function frameFromPersisted(live: LiveTurn, persisted: PersistedTurnFrame): MobileWsServerFrame {
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
  frame: ResumableSendFrame,
  accepted: AcceptedTurn,
  origin: ConversationMessageOrigin,
  kind: ConversationKind,
  requestId?: string,
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
    ...(ordinary ? {} : { origin, kind }),
    // Spread, never `requestId: undefined`: `ChatAccepted` is
    // `additionalProperties: false` and a present-but-undefined key would
    // serialise away over JSON but still show up to an in-process sink.
    ...(requestId !== undefined ? { requestId } : {}),
  };
}

export function createResumableChatHub(options: ResumableChatHubOptions): ResumableChatHub {
  const { conversations, agents } = options;
  const turns = new Map<string, LiveTurn>();
  const conversationSubscribers = new Map<string, Set<TurnFrameSink>>();
  const observers = new Set<TurnObserver>();
  const quiescingAgents = new Set<string>();
  let stopped = false;

  const assertAccepting = (): void => {
    if (stopped) throw new Error('Resumable chat hub is stopped');
  };

  const assertAgentAccepting = (agentId: string): void => {
    assertAccepting();
    if (quiescingAgents.has(agentId)) {
      throw new ConversationServiceError(
        'conversation_busy',
        `Agent ${agentId} is not accepting new turns`,
        409,
        true,
      );
    }
  };

  const assertOwnedConversation = (agentId: string, conversationId: string): void => {
    const conversation = conversations.get(conversationId);
    if (!conversation || conversation.agentId !== agentId) {
      throw new ConversationServiceError('not_found', 'Conversation not found', 404, false);
    }
  };

  const send = (sink: TurnFrameSink, frame: MobileWsServerFrame): boolean => {
    try {
      sink.send(frame);
      return true;
    } catch {
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
  const broadcast = (live: LiveTurn, frame: MobileWsServerFrame): void => {
    const key = conversationKey(live.agentId, live.conversationId);
    const watchers = live.origin === 'user' ? undefined : conversationSubscribers.get(key);
    for (const sink of live.subscribers) {
      if (send(sink, frame)) continue;
      live.subscribers.delete(sink);
      removeConversationSubscriber(key, sink);
    }
    if (!watchers) return;
    for (const sink of [...watchers]) {
      if (live.subscribers.has(sink)) continue;
      if (!send(sink, frame)) removeConversationSubscriber(key, sink);
    }
  };

  const observedTurn = (live: LiveTurn): ObservedTurn => ({
    agentId: live.agentId,
    conversationId: live.conversationId,
    turnId: live.turnId,
  });

  const notifyEvent = (live: LiveTurn, event: AgentEvent): void => {
    if (observers.size === 0) return;
    const turn = observedTurn(live);
    for (const observer of [...observers]) {
      try {
        observer.onEvent(turn, event);
      } catch (error) {
        console.error('[resumable-chat-hub] turn observer onEvent threw', error);
      }
    }
  };

  const notifyFinish = (live: LiveTurn, outcome: TurnOutcome, error?: string): void => {
    if (live.finishNotified) return;
    live.finishNotified = true;
    if (observers.size === 0) return;
    const turn = observedTurn(live);
    for (const observer of [...observers]) {
      try {
        observer.onFinish(turn, outcome, error);
      } catch (error) {
        console.error('[resumable-chat-hub] turn observer onFinish threw', error);
      }
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
    const live = turns.get(turnId);
    if (
      conversation?.activeTurnId === turnId &&
      live?.agentId === agentId &&
      live.conversationId === conversationId
    ) {
      live.subscribers.add(sink);
    }
  };

  const finish = (live: LiveTurn, outcome: 'completed' | 'cancelled'): PersistedTurnFrame => {
    const persisted = conversations.finishTurn({
      conversationId: live.conversationId,
      turnId: live.turnId,
      outcome,
    });
    live.terminal = true;
    broadcast(live, frameFromPersisted(live, persisted));
    notifyFinish(live, outcome);
    options.onChanged?.(persisted.conversation);
    return persisted;
  };

  const runTurn = async (live: LiveTurn, frame: ResumableSendFrame): Promise<void> => {
    let stream: ReturnType<AgentChatCoordinator['chat']> | undefined;
    try {
      stream = agents.chat({
        agentId: frame.agentId,
        conversationId: frame.conversationId,
        channelId: frame.channelId,
        text: frame.text,
        images: frame.images?.length
          ? frame.images.map((image) => ({ type: 'image' as const, ...image }))
          : undefined,
        location: toClientLocation(frame.location),
        messageId: frame.id,
        signal: live.controller.signal,
      });
      while (true) {
        const result = await stream.next();
        if (result.done) break;
        const event = result.value;
        if (event.type === 'error') throw event.error;
        notifyEvent(live, event);
        if (isTransientAgentEvent(event)) {
          // Spec §7.2: live-stream only. Subscribers still see it, but it is
          // never persisted — hence no seq, and no row for a resume to replay.
          broadcast(live, {
            type: 'event',
            id: live.turnId,
            conversationId: live.conversationId,
            event,
          });
          continue;
        }
        const persisted = conversations.appendTurnEvent(live.conversationId, live.turnId, event);
        if (persisted) broadcast(live, frameFromPersisted(live, persisted));
      }
      if (!live.cancelled) {
        finish(live, 'completed');
        // A CHILD's turn is never swept or reviewed. Both services key on
        // `agentId`, and a child conversation carries its PARENT's — so a
        // child's transcript would be extracted into the parent's memory dir
        // and its managed skills dir, and the resulting notice would be posted
        // into the child's conversation. That is the write path the child was
        // deliberately denied: it inherits memory read-only (`tools: false` in
        // `buildChildAgentConfig`), and a `skipMemory` type gets none at all.
        // Children report to their parent; the parent decides what is kept.
        if (live.kind !== 'subagent') {
          options.memorySweep?.schedule({
            agentId: live.agentId,
            conversationId: live.conversationId,
            turnId: live.turnId,
          });
          // Only completed turns are reviewed: a failed or cancelled turn has no
          // outcome to learn from, and half of one is worse than none.
          options.skillReview?.schedule({
            agentId: live.agentId,
            conversationId: live.conversationId,
            turnId: live.turnId,
          });
        }
      }
    } catch (error) {
      if (!live.cancelled) {
        const message = error instanceof Error ? error.message : String(error);
        const persisted = conversations.finishTurn({
          conversationId: live.conversationId,
          turnId: live.turnId,
          outcome: 'failed',
          error: message,
          retryable: false,
        });
        live.terminal = true;
        broadcast(live, frameFromPersisted(live, persisted));
        notifyFinish(live, 'failed', message);
        options.onChanged?.(persisted.conversation);
      }
    } finally {
      try {
        if (stream) await stream.return(undefined);
      } finally {
        live.settled = true;
        // Both terminal paths above persist BEFORE notifying, so a throwing
        // finishTurn would otherwise leave observers waiting forever on a run
        // that is over. Report it as failed; `finishNotified` keeps a later
        // successful cancel retry from double-reporting.
        notifyFinish(live, 'failed');
        if (live.terminal && turns.get(live.turnId) === live) turns.delete(live.turnId);
      }
    }
  };

  const cancelLive = (live: LiveTurn, sink?: TurnFrameSink): void => {
    if (live.terminal) return;
    if (sink) live.subscribers.add(sink);
    if (live.cancelled) return;
    const recoveringSettledFailure = live.settled;
    finish(live, 'cancelled');
    live.cancelled = true;
    live.controller.abort();
    agents.cancel(live.agentId, live.conversationId);
    options.swarmCoordinator?.cancelTurn(live.agentId, live.conversationId);
    // A settled, non-terminal live turn exists only when its earlier terminal
    // persistence failed. Once this retry succeeds, do not let that historical
    // rejection make cancelAgent() or stop() report a false cleanup failure.
    if (recoveringSettledFailure) live.promise = live.promise.catch(() => {});
    if (live.settled && turns.get(live.turnId) === live) turns.delete(live.turnId);
  };

  /**
   * The one accept → run path. `start` supplies the socket that sent the
   * frame; `startSystemTurn` supplies none, so the turn reaches conversation
   * subscribers only. Keeping both on this function is what stops the
   * turn-lease and auto-title behaviour from drifting between them.
   */
  const acceptAndRun = (
    frame: ResumableSendFrame,
    sink: TurnFrameSink | undefined,
    origin: ConversationMessageOrigin,
    requestId?: string,
  ): void => {
    assertAgentAccepting(frame.agentId);
    const accepted = conversations.acceptTurn({
      agentId: frame.agentId,
      conversationId: frame.conversationId,
      turnId: frame.id,
      text: frame.text,
      images: frame.images,
      origin,
    });
    const acceptedFrame = frameFromAccepted(
      frame,
      accepted,
      origin,
      accepted.conversation.kind,
      requestId,
    );

    if (!accepted.created) {
      // Idempotent re-send of a turn we already accepted: catch this socket up
      // rather than starting a second run. Nothing to replay without a sink.
      if (!sink || !send(sink, acceptedFrame)) return;
      if (!replay(frame.agentId, frame.conversationId, accepted.seq, sink)) return;
      addConversationSubscriber(conversationKey(frame.agentId, frame.conversationId), sink);
      attachIfLive(frame.id, frame.agentId, frame.conversationId, sink);
      return;
    }

    const live: LiveTurn = {
      turnId: frame.id,
      agentId: frame.agentId,
      conversationId: frame.conversationId,
      origin,
      kind: accepted.conversation.kind,
      controller: new AbortController(),
      subscribers: new Set(sink ? [sink] : []),
      cancelled: false,
      terminal: false,
      settled: false,
      finishNotified: false,
      promise: Promise.resolve(),
    };
    turns.set(frame.id, live);
    // Sending a message subscribes the socket to the conversation, so an
    // existing client receives later server-initiated turns with no change.
    if (sink) addConversationSubscriber(conversationKey(frame.agentId, frame.conversationId), sink);
    // A failed send here drops the sink from both sets, exactly as it did
    // when `accepted` was written straight to the socket.
    broadcast(live, acceptedFrame);
    if (accepted.firstUserMessage) {
      options.autoTitle.schedule({
        conversationId: frame.conversationId,
        agentId: frame.agentId,
        text: frame.text,
      });
    }
    options.onChanged?.(accepted.conversation);
    live.promise = runTurn(live, frame);
    void live.promise.catch(() => {});
  };

  const hub: ResumableChatHub = {
    start(frame, sink) {
      acceptAndRun(frame, sink, 'user');
    },

    startSystemTurn({ agentId, conversationId, text, origin, turnId, requestId }) {
      const frame: ResumableSendFrame = {
        type: 'message',
        id: turnId ?? randomUUID(),
        agentId,
        channelId: 'system',
        conversationId,
        text,
        resumable: true,
      };
      // A `conversation_busy` from acceptTurn propagates on purpose: the
      // caller queues the notification and drains it on the next finishTurn.
      acceptAndRun(frame, undefined, origin, requestId);
      return { turnId: frame.id };
    },

    resume(frame, sink) {
      assertAccepting();
      assertOwnedConversation(frame.agentId, frame.conversationId);
      if (!replay(frame.agentId, frame.conversationId, frame.sinceSeq, sink)) return;
      addConversationSubscriber(conversationKey(frame.agentId, frame.conversationId), sink);
      attachIfLive(frame.id, frame.agentId, frame.conversationId, sink);
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
      observers.add(observer);
      return () => {
        observers.delete(observer);
      };
    },

    async answer(turnId, questionId, answer) {
      assertAccepting();
      const live = turns.get(turnId);
      if (!live || live.terminal) {
        throw new ConversationServiceError('not_found', `Turn ${turnId} is not live`, 404, false);
      }
      await agents.answerQuestion(live.agentId, live.conversationId, questionId, answer);
    },

    async cancel(turnId, sink) {
      assertAccepting();
      const live = turns.get(turnId);
      if (live) cancelLive(live, sink);
    },

    detach(sink) {
      for (const live of turns.values()) live.subscribers.delete(sink);
      // Conversation subscriptions outlive any single turn, so a closed socket
      // that is only dropped from live turns would keep being written to for
      // every future turn on that conversation.
      for (const [key, sinks] of conversationSubscribers) {
        if (!sinks.delete(sink)) continue;
        if (sinks.size === 0) conversationSubscribers.delete(key);
      }
    },

    async cancelAgent(agentId) {
      quiescingAgents.add(agentId);
      const matching = [...turns.values()].filter((live) => live.agentId === agentId);
      for (const live of matching) cancelLive(live);
      await Promise.all(matching.map((live) => live.promise));
    },

    allowAgent(agentId) {
      quiescingAgents.delete(agentId);
    },

    async stop() {
      stopped = true;
      const active = [...turns.values()];
      for (const live of active) cancelLive(live);
      await Promise.all(active.map((live) => live.promise));
      conversationSubscribers.clear();
      observers.clear();
    },
  };

  return hub;
}
