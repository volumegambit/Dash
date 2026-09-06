import type {
  ConversationSummary,
  MobileWsClientFrame,
  MobileWsServerFrame,
} from '@dash/mobile-contract';
import type {
  MobileV2SequencedFrame,
  MobileV2WsClientFrame,
  MobileV2WsServerFrame,
} from '@dash/mobile-contract-v2';
import type { AgentChatCoordinator } from './agent-chat-coordinator.js';
import { toClientLocation } from './client-location.js';
import type { ConversationAutoTitleService } from './conversation-auto-title.js';
import { mapConversationV1 } from './conversation-contract-mappers.js';
import type { AcceptedRun, PersistedRunFrames, StoredConversation } from './conversation-domain.js';
import { type ConversationService, ConversationServiceError } from './conversation-service.js';
import type { EventLogEntry, EventLogPayload } from './event-log-store.js';
import type { MemorySweepService } from './memory-sweep.js';
import type { SkillReviewService } from './skill-review.js';

export type ResumableSendFrame = Extract<MobileWsClientFrame, { type: 'message' }> & {
  resumable: true;
};
export type ResumeFrame = Extract<MobileWsClientFrame, { type: 'resume' }>;

export interface V1TurnFrameSink {
  send(frame: MobileWsServerFrame): void;
}

/** Backwards-compatible name retained for the frozen v1 socket router. */
export type TurnFrameSink = V1TurnFrameSink;

export interface V2ConversationFrameSink {
  send(frame: MobileV2WsServerFrame): void;
}

export interface ResumableChatHubOptions {
  conversations: ConversationService;
  agents: AgentChatCoordinator;
  autoTitle: ConversationAutoTitleService;
  isAgentEnabled(agentId: string): boolean;
  /** Optional post-turn memory sweep; scheduled only for runs that complete. */
  memorySweep?: Pick<MemorySweepService, 'schedule'>;
  skillReview?: Pick<SkillReviewService, 'schedule'>;
  swarmCoordinator?: { cancelTurn(agentId: string, conversationId: string): boolean };
  onChanged?(summary: ConversationSummary): void;
}

export interface ResumableChatHub {
  start(frame: ResumableSendFrame, sink: V1TurnFrameSink): void;
  startV2(
    frame: Extract<MobileV2WsClientFrame, { type: 'message' }>,
    sink: V2ConversationFrameSink,
  ): void;
  resume(frame: ResumeFrame, sink: V1TurnFrameSink): void;
  subscribeConversation(
    frame: Extract<MobileV2WsClientFrame, { type: 'subscribe_conversation' }>,
    sink: V2ConversationFrameSink,
  ): void;
  answer(runId: string, questionId: string, answer: string, sink?: V1TurnFrameSink): Promise<void>;
  answerV2(
    frame: Extract<MobileV2WsClientFrame, { type: 'answer' }>,
    sink: V2ConversationFrameSink,
  ): Promise<void>;
  cancel(runId: string, sink?: V1TurnFrameSink): Promise<void>;
  cancelV2(
    frame: Extract<MobileV2WsClientFrame, { type: 'cancel' }>,
    sink: V2ConversationFrameSink,
  ): Promise<void>;
  detach(sink: V1TurnFrameSink | V2ConversationFrameSink): void;
  cancelAgent(agentId: string): Promise<void>;
  allowAgent(agentId: string): void;
  stop(): Promise<void>;
}

interface LiveRun {
  runId: string;
  currentSegmentTurnId: string;
  agentId: string;
  conversationId: string;
  channelId: string;
  controller: AbortController;
  v1Subscribers: Set<V1TurnFrameSink>;
  admissionOpen: boolean;
  cancelRequested: boolean;
  terminal: boolean;
  settled: boolean;
  serializedTail: Promise<void>;
  promise: Promise<void>;
  resolvePromise(): void;
  rejectPromise(error: unknown): void;
}

interface V2Subscription {
  sink: V2ConversationFrameSink;
  agentId: string;
  conversationId: string;
  replaying: boolean;
  buffer: MobileV2SequencedFrame[];
  deliveredThrough: number;
  active: boolean;
  version: number;
}

interface OutboundState {
  draining: boolean;
  queue: Array<() => void>;
}

function liveRunKey(agentId: string, conversationId: string): string {
  return JSON.stringify([agentId, conversationId]);
}

function frameFromEntry(entry: EventLogEntry): MobileWsServerFrame {
  return frameFromV1Payload(entry.msgId, entry.conversationId, entry.seq, entry.payload);
}

function frameFromV1Payload(
  runId: string,
  conversationId: string,
  seq: number,
  payload: EventLogPayload,
): MobileWsServerFrame {
  const common = { id: runId, conversationId, seq };
  switch (payload.type) {
    case 'accepted':
      return {
        type: 'accepted',
        ...common,
        userMessageId: payload.userMessageId,
        assistantMessageId: payload.assistantMessageId,
        revision: payload.revision,
      };
    case 'event':
      return { type: 'event', ...common, event: payload.event };
    case 'done':
      return { type: 'done', ...common, outcome: payload.outcome ?? 'completed' };
    case 'error':
      return {
        type: 'error',
        ...common,
        error: payload.error,
        code: payload.code,
        retryable: payload.retryable,
      };
  }
}

function acceptedFrames(accepted: AcceptedRun): PersistedRunFrames {
  return {
    conversation: accepted.conversation,
    v1Seq: accepted.v1Seq,
    v1Payload: accepted.v1Payload,
    v2Frame: accepted.v2Frame,
  };
}

export function createResumableChatHub(options: ResumableChatHubOptions): ResumableChatHub {
  const { conversations, agents } = options;
  const liveRuns = new Map<string, LiveRun>();
  const v1RunBySink = new Map<V1TurnFrameSink, string>();
  const v2Subscriptions = new Map<string, Set<V2Subscription>>();
  const v2SubscriptionBySink = new Map<V2ConversationFrameSink, V2Subscription>();
  const pendingV2SubscriptionBySink = new Map<V2ConversationFrameSink, V2Subscription>();
  const v2SubscriptionVersions = new Map<V2ConversationFrameSink, number>();
  const outboundByConversation = new Map<string, OutboundState>();
  const quiescingAgents = new Set<string>();
  let stopped = false;

  const assertAccepting = (): void => {
    if (stopped) throw new Error('Resumable chat hub is stopped');
  };

  const assertAgentAccepting = (agentId: string): void => {
    assertAccepting();
    if (quiescingAgents.has(agentId) || !options.isAgentEnabled(agentId)) {
      throw new ConversationServiceError(
        'conversation_busy',
        `Agent ${agentId} is not accepting new turns`,
        409,
        true,
      );
    }
  };

  const notifyChanged = (conversation: StoredConversation): void => {
    try {
      options.onChanged?.(mapConversationV1(conversation));
    } catch {
      // The SQLite commit is authoritative. Observer failures cannot reverse it
      // or reclassify the provider outcome.
    }
  };

  const sendV1 = (sink: V1TurnFrameSink, frame: MobileWsServerFrame): boolean => {
    try {
      sink.send(frame);
      return true;
    } catch {
      return false;
    }
  };

  const sendV2 = (sink: V2ConversationFrameSink, frame: MobileV2WsServerFrame): boolean => {
    try {
      sink.send(frame);
      return true;
    } catch {
      return false;
    }
  };

  const removeV1Sink = (sink: V1TurnFrameSink, expectedKey?: string): void => {
    const key = v1RunBySink.get(sink);
    if (!key || (expectedKey !== undefined && key !== expectedKey)) return;
    v1RunBySink.delete(sink);
    liveRuns.get(key)?.v1Subscribers.delete(sink);
  };

  const attachV1Sink = (live: LiveRun, sink: V1TurnFrameSink): void => {
    removeV1Sink(sink);
    const key = liveRunKey(live.agentId, live.conversationId);
    live.v1Subscribers.add(sink);
    v1RunBySink.set(sink, key);
  };

  const removeV2Subscription = (subscription: V2Subscription): void => {
    const records = v2Subscriptions.get(subscription.conversationId);
    records?.delete(subscription);
    if (records?.size === 0) v2Subscriptions.delete(subscription.conversationId);
    if (v2SubscriptionBySink.get(subscription.sink) === subscription) {
      v2SubscriptionBySink.delete(subscription.sink);
    }
    if (pendingV2SubscriptionBySink.get(subscription.sink) === subscription) {
      pendingV2SubscriptionBySink.delete(subscription.sink);
    }
    subscription.active = false;
  };

  const deliverV2 = (subscription: V2Subscription, frame: MobileV2SequencedFrame): boolean => {
    if (frame.v2Seq <= subscription.deliveredThrough) return true;
    if (!sendV2(subscription.sink, frame)) {
      removeV2Subscription(subscription);
      return false;
    }
    subscription.deliveredThrough = frame.v2Seq;
    return true;
  };

  const broadcastV1Now = (live: LiveRun, frame: MobileWsServerFrame): void => {
    const key = liveRunKey(live.agentId, live.conversationId);
    for (const sink of live.v1Subscribers) {
      if (!sendV1(sink, frame)) removeV1Sink(sink, key);
    }
  };

  const broadcastV2Now = (frame: MobileV2SequencedFrame): void => {
    const records = v2Subscriptions.get(frame.conversationId);
    if (!records) return;
    for (const subscription of [...records]) {
      if (!subscription.active) {
        if (pendingV2SubscriptionBySink.get(subscription.sink) !== subscription) continue;
      } else {
        const pending = pendingV2SubscriptionBySink.get(subscription.sink);
        if (pending?.conversationId === frame.conversationId) continue;
      }
      if (subscription.replaying) {
        subscription.buffer.push(frame);
      } else {
        deliverV2(subscription, frame);
      }
    }
  };

  const queueOutbound = (conversationId: string, operation: () => void): void => {
    let state = outboundByConversation.get(conversationId);
    if (!state) {
      state = { draining: false, queue: [] };
      outboundByConversation.set(conversationId, state);
    }
    state.queue.push(operation);
    if (state.draining) return;
    state.draining = true;
    try {
      while (state.queue.length > 0) state.queue.shift()?.();
    } finally {
      state.draining = false;
      if (state.queue.length === 0) outboundByConversation.delete(conversationId);
    }
  };

  const broadcastRunFrames = (live: LiveRun, persisted: PersistedRunFrames): void => {
    const v1Frame = frameFromV1Payload(
      live.runId,
      live.conversationId,
      persisted.v1Seq,
      persisted.v1Payload,
    );
    queueOutbound(live.conversationId, () => {
      broadcastV1Now(live, v1Frame);
      broadcastV2Now(persisted.v2Frame);
    });
  };

  const replayV1 = (
    agentId: string,
    conversationId: string,
    sinceSeq: number,
    sink: V1TurnFrameSink,
  ): boolean => {
    for (const entry of conversations.eventLog.readSince(agentId, conversationId, sinceSeq)) {
      if (!sendV1(sink, frameFromEntry(entry))) return false;
    }
    return true;
  };

  const attachV1IfLive = (
    runId: string,
    agentId: string,
    conversationId: string,
    sink: V1TurnFrameSink,
  ): void => {
    const conversation = conversations.get(conversationId);
    const live = liveRuns.get(liveRunKey(agentId, conversationId));
    if (conversation?.activeTurnId === runId && live?.runId === runId && !live.terminal) {
      attachV1Sink(live, sink);
    }
  };

  const removeLiveRun = (live: LiveRun): void => {
    const key = liveRunKey(live.agentId, live.conversationId);
    if (liveRuns.get(key) !== live) return;
    liveRuns.delete(key);
    for (const sink of live.v1Subscribers) removeV1Sink(sink, key);
  };

  const withLiveRunLock = <T>(live: LiveRun, operation: () => T | Promise<T>): Promise<T> => {
    const result = live.serializedTail.catch(() => {}).then(operation);
    live.serializedTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const requireLiveRun = (runId: string, sink?: V1TurnFrameSink): LiveRun => {
    if (sink) {
      const key = v1RunBySink.get(sink);
      const live = key ? liveRuns.get(key) : undefined;
      if (live?.runId === runId && !live.terminal) return live;
      throw new ConversationServiceError('not_found', `Run ${runId} is not live`, 404, false);
    }
    const matches = [...liveRuns.values()].filter(
      (candidate) => candidate.runId === runId && !candidate.terminal,
    );
    if (matches.length === 1) return matches[0] as LiveRun;
    throw new ConversationServiceError('not_found', `Run ${runId} is not live`, 404, false);
  };

  const requireV2Subscription = (
    sink: V2ConversationFrameSink,
    expectedConversationId?: string,
    expectedAgentId?: string,
  ): V2Subscription => {
    const subscription = v2SubscriptionBySink.get(sink);
    if (
      !subscription ||
      (expectedConversationId !== undefined &&
        subscription.conversationId !== expectedConversationId) ||
      (expectedAgentId !== undefined && subscription.agentId !== expectedAgentId)
    ) {
      throw new ConversationServiceError(
        'not_found',
        'V2 sink is not subscribed to this conversation',
        404,
        false,
      );
    }
    return subscription;
  };

  const requireV2LiveRun = (runId: string, sink: V2ConversationFrameSink): LiveRun => {
    const subscription = requireV2Subscription(sink);
    const live = liveRuns.get(liveRunKey(subscription.agentId, subscription.conversationId));
    if (!live || live.runId !== runId || live.terminal) {
      throw new ConversationServiceError('not_found', `Run ${runId} is not live`, 404, false);
    }
    return live;
  };

  const createLiveRun = (accepted: AcceptedRun): LiveRun => {
    let resolvePromise!: () => void;
    let rejectPromise!: (error: unknown) => void;
    const promise = new Promise<void>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    return {
      runId: accepted.runId,
      currentSegmentTurnId: accepted.segmentTurnId,
      agentId: accepted.conversation.agentId,
      conversationId: accepted.conversation.id,
      channelId: accepted.channelId,
      controller: new AbortController(),
      v1Subscribers: new Set(),
      admissionOpen: true,
      cancelRequested: false,
      terminal: false,
      settled: false,
      serializedTail: Promise.resolve(),
      promise,
      resolvePromise,
      rejectPromise,
    };
  };

  const persistTerminal = (
    live: LiveRun,
    outcome:
      | { outcome: 'completed' | 'cancelled' }
      | { outcome: 'failed'; error: string; retryable: boolean },
  ): void => {
    const result = conversations.finishRunAndClaimNext({
      conversationId: live.conversationId,
      runId: live.runId,
      segmentTurnId: live.currentSegmentTurnId,
      ...outcome,
      suppressPromotion: true,
    });
    live.admissionOpen = false;
    live.terminal = true;
    notifyChanged(result.terminal.conversation);
    broadcastRunFrames(live, result.terminal);
    for (const transition of result.transitions) {
      queueOutbound(live.conversationId, () => broadcastV2Now(transition.frame));
    }
  };

  const runLive = async (
    live: LiveRun,
    accepted: AcceptedRun,
    location?: Extract<MobileWsClientFrame, { type: 'message' }>['location'],
  ): Promise<void> => {
    let stream: ReturnType<AgentChatCoordinator['chat']> | undefined;
    try {
      const deliveredSteers = conversations
        .listDeliveredSteers(live.conversationId)
        .map((record) => ({
          inputId: record.inputId,
          content: {
            text: record.text,
            ...(record.images !== undefined
              ? {
                  images: record.images.map((image) => ({ type: 'image' as const, ...image })),
                }
              : {}),
          },
        }));
      if (
        live.controller.signal.aborted ||
        live.cancelRequested ||
        live.terminal ||
        liveRuns.get(liveRunKey(live.agentId, live.conversationId)) !== live
      ) {
        return;
      }
      stream = agents.chat({
        agentId: live.agentId,
        conversationId: live.conversationId,
        runId: live.runId,
        channelId: live.channelId,
        text: accepted.text,
        images: accepted.images?.map((image) => ({ type: 'image' as const, ...image })),
        location: toClientLocation(location),
        messageId: accepted.userMessage.id,
        signal: live.controller.signal,
        deliveredSteers,
      });
      while (true) {
        const result = await stream.next();
        if (result.done) break;
        const event = result.value;
        if (event.type === 'error') throw event.error;
        await withLiveRunLock(live, () => {
          if (live.terminal) return;
          const persisted = conversations.appendRunEvent({
            conversationId: live.conversationId,
            runId: live.runId,
            segmentTurnId: live.currentSegmentTurnId,
            event,
          });
          if (persisted) broadcastRunFrames(live, persisted);
        });
      }
      await withLiveRunLock(live, () => {
        if (live.terminal) return;
        persistTerminal(live, { outcome: 'completed' });
        options.memorySweep?.schedule({
          agentId: live.agentId,
          conversationId: live.conversationId,
          runId: live.runId,
        });
        options.skillReview?.schedule({
          agentId: live.agentId,
          conversationId: live.conversationId,
          runId: live.runId,
        });
      });
    } catch (error) {
      await withLiveRunLock(live, () => {
        if (live.terminal) return;
        persistTerminal(live, {
          outcome: 'failed',
          error: error instanceof Error ? error.message : String(error),
          retryable: false,
        });
      });
    } finally {
      try {
        if (stream) await stream.return(undefined);
      } finally {
        live.settled = true;
        if (live.terminal) removeLiveRun(live);
      }
    }
  };

  const beginLiveRun = (
    live: LiveRun,
    accepted: AcceptedRun,
    location?: Extract<MobileWsClientFrame, { type: 'message' }>['location'],
  ): void => {
    const execution = runLive(live, accepted, location);
    void execution.then(live.resolvePromise, live.rejectPromise);
    void live.promise.catch(() => {});
  };

  const registerAcceptedRun = (
    accepted: AcceptedRun,
    location?: Extract<MobileWsClientFrame, { type: 'message' }>['location'],
    v1Sink?: V1TurnFrameSink,
  ): LiveRun => {
    const live = createLiveRun(accepted);
    const key = liveRunKey(live.agentId, live.conversationId);
    liveRuns.set(key, live);
    if (v1Sink) attachV1Sink(live, v1Sink);
    notifyChanged(accepted.conversation);
    if (accepted.firstUserMessage) {
      try {
        options.autoTitle.schedule({
          conversationId: live.conversationId,
          agentId: live.agentId,
          text: accepted.text,
        });
      } catch {
        // The accepted run is already durable. A title observer cannot strand it
        // before its frames are broadcast and provider execution begins.
      }
    }
    broadcastRunFrames(live, acceptedFrames(accepted));
    beginLiveRun(live, accepted, location);
    return live;
  };

  const cancelLive = (live: LiveRun, sink?: V1TurnFrameSink): Promise<void> => {
    if (sink) attachV1Sink(live, sink);
    live.cancelRequested = true;
    return withLiveRunLock(live, () => {
      if (live.terminal) return;
      const recoveringSettledFailure = live.settled;
      persistTerminal(live, { outcome: 'cancelled' });
      live.controller.abort();
      agents.cancel(live.agentId, live.conversationId);
      options.swarmCoordinator?.cancelTurn(live.agentId, live.conversationId);
      if (recoveringSettledFailure) {
        live.promise = live.promise.catch(() => {});
      }
      if (live.settled) removeLiveRun(live);
    });
  };

  const startAccepted = (
    protocol: 'v1' | 'v2',
    frame: ResumableSendFrame | Extract<MobileV2WsClientFrame, { type: 'message' }>,
    v1Sink?: V1TurnFrameSink,
    v2Sink?: V2ConversationFrameSink,
  ): void => {
    assertAgentAccepting(frame.agentId);
    if (protocol === 'v2' && v2Sink) {
      requireV2Subscription(v2Sink, frame.conversationId, frame.agentId);
    }
    const accepted = conversations.acceptRun({
      protocol,
      agentId: frame.agentId,
      channelId: frame.channelId,
      conversationId: frame.conversationId,
      runId: frame.id,
      text: frame.text,
      images: frame.images,
    });
    if (!accepted.created) {
      if (protocol === 'v1' && v1Sink) {
        const sent = sendV1(
          v1Sink,
          frameFromV1Payload(
            accepted.runId,
            accepted.conversation.id,
            accepted.v1Seq,
            accepted.v1Payload,
          ),
        );
        if (
          sent &&
          replayV1(accepted.conversation.agentId, accepted.conversation.id, accepted.v1Seq, v1Sink)
        ) {
          attachV1IfLive(
            accepted.runId,
            accepted.conversation.agentId,
            accepted.conversation.id,
            v1Sink,
          );
        }
      } else if (protocol === 'v2' && v2Sink) {
        sendV2(v2Sink, accepted.v2Frame);
      }
      return;
    }
    registerAcceptedRun(accepted, frame.location, v1Sink);
  };

  const hub: ResumableChatHub = {
    start(frame, sink) {
      startAccepted('v1', frame, sink);
    },

    startV2(frame, sink) {
      startAccepted('v2', frame, undefined, sink);
    },

    resume(frame, sink) {
      assertAccepting();
      const conversation = conversations.get(frame.conversationId);
      if (!conversation || conversation.agentId !== frame.agentId) {
        throw new ConversationServiceError('not_found', 'Conversation not found', 404, false);
      }
      if (!replayV1(frame.agentId, frame.conversationId, frame.sinceSeq, sink)) return;
      attachV1IfLive(frame.id, frame.agentId, frame.conversationId, sink);
    },

    subscribeConversation(frame, sink) {
      assertAccepting();
      const version = (v2SubscriptionVersions.get(sink) ?? 0) + 1;
      v2SubscriptionVersions.set(sink, version);
      const previous = v2SubscriptionBySink.get(sink);
      const subscription: V2Subscription = {
        sink,
        agentId: frame.agentId,
        conversationId: frame.conversationId,
        replaying: true,
        buffer: [],
        deliveredThrough: 0,
        active: false,
        version,
      };
      let records = v2Subscriptions.get(frame.conversationId);
      if (!records) {
        records = new Set();
        v2Subscriptions.set(frame.conversationId, records);
      }
      records.add(subscription);
      pendingV2SubscriptionBySink.set(sink, subscription);
      const replayIsCurrent = (): boolean =>
        v2SubscriptionVersions.get(sink) === version &&
        pendingV2SubscriptionBySink.get(sink) === subscription;
      const abandonSupersededReplay = (): boolean => {
        if (replayIsCurrent()) return false;
        removeV2Subscription(subscription);
        return true;
      };

      try {
        const replay = conversations.readV2Since(
          frame.agentId,
          frame.conversationId,
          frame.sinceV2Seq,
        );
        subscription.deliveredThrough = Math.min(frame.sinceV2Seq, replay.throughSeq);
        for (const replayFrame of replay.frames) {
          if (abandonSupersededReplay()) return;
          if (replayFrame.v2Seq <= frame.sinceV2Seq) continue;
          if (!deliverV2(subscription, replayFrame)) throw new Error('V2 replay sink failed');
          if (abandonSupersededReplay()) return;
        }
        subscription.deliveredThrough = Math.max(subscription.deliveredThrough, replay.throughSeq);
        while (subscription.buffer.length > 0) {
          if (abandonSupersededReplay()) return;
          const wave = subscription.buffer.splice(0).sort((a, b) => a.v2Seq - b.v2Seq);
          for (const buffered of wave) {
            if (abandonSupersededReplay()) return;
            if (!deliverV2(subscription, buffered)) throw new Error('V2 replay sink failed');
            if (abandonSupersededReplay()) return;
          }
          if (abandonSupersededReplay()) return;
        }
        if (abandonSupersededReplay()) return;
        subscription.replaying = false;
        subscription.active = true;
        if (previous && previous !== subscription) removeV2Subscription(previous);
        v2SubscriptionBySink.set(sink, subscription);
        if (pendingV2SubscriptionBySink.get(sink) === subscription) {
          pendingV2SubscriptionBySink.delete(sink);
        }
        if (
          !sendV2(sink, {
            type: 'conversation_subscribed',
            id: frame.id,
            conversationId: frame.conversationId,
            v2ThroughSeq: subscription.deliveredThrough,
          })
        ) {
          removeV2Subscription(subscription);
        }
      } catch (error) {
        const buffered = subscription.buffer.splice(0).sort((a, b) => a.v2Seq - b.v2Seq);
        removeV2Subscription(subscription);
        if (
          previous?.active &&
          previous.conversationId === frame.conversationId &&
          v2SubscriptionBySink.get(sink) === previous
        ) {
          for (const bufferedFrame of buffered) deliverV2(previous, bufferedFrame);
        }
        throw error;
      }
    },

    async answer(runId, questionId, answer, sink) {
      assertAccepting();
      const live = requireLiveRun(runId, sink);
      await withLiveRunLock(live, async () => {
        if (live.terminal) {
          throw new ConversationServiceError('not_found', `Run ${runId} is not live`, 404, false);
        }
        await agents.answerQuestion(live.agentId, live.conversationId, questionId, answer);
      });
    },

    async answerV2(frame, sink) {
      assertAccepting();
      const live = requireV2LiveRun(frame.id, sink);
      await withLiveRunLock(live, async () => {
        if (live.terminal) {
          throw new ConversationServiceError(
            'not_found',
            `Run ${frame.id} is not live`,
            404,
            false,
          );
        }
        await agents.answerQuestion(
          live.agentId,
          live.conversationId,
          frame.questionId,
          frame.answer,
        );
      });
    },

    async cancel(runId, sink) {
      assertAccepting();
      let live: LiveRun;
      try {
        live = requireLiveRun(runId, sink);
      } catch (error) {
        if (
          sink === undefined &&
          error instanceof ConversationServiceError &&
          error.code === 'not_found'
        ) {
          return;
        }
        throw error;
      }
      await cancelLive(live, sink);
    },

    async cancelV2(frame, sink) {
      assertAccepting();
      const live = requireV2LiveRun(frame.id, sink);
      await cancelLive(live);
    },

    detach(sink) {
      removeV1Sink(sink as V1TurnFrameSink);
      const subscription = v2SubscriptionBySink.get(sink as V2ConversationFrameSink);
      if (subscription) removeV2Subscription(subscription);
      const pending = pendingV2SubscriptionBySink.get(sink as V2ConversationFrameSink);
      if (pending) removeV2Subscription(pending);
      v2SubscriptionVersions.set(
        sink as V2ConversationFrameSink,
        (v2SubscriptionVersions.get(sink as V2ConversationFrameSink) ?? 0) + 1,
      );
    },

    async cancelAgent(agentId) {
      quiescingAgents.add(agentId);
      const matching = [...liveRuns.values()].filter((live) => live.agentId === agentId);
      await Promise.all(matching.map((live) => cancelLive(live)));
      await Promise.all(matching.map((live) => live.promise));
    },

    allowAgent(agentId) {
      quiescingAgents.delete(agentId);
    },

    async stop() {
      stopped = true;
      const active = [...liveRuns.values()];
      await Promise.all(active.map((live) => cancelLive(live)));
      await Promise.all(active.map((live) => live.promise));
    },
  };

  return hub;
}
