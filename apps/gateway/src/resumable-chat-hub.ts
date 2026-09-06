import type { ClientLocation } from '@dash/agent';
import type {
  ConversationSummary,
  MobileApiErrorCode,
  MobileWsClientFrame,
  MobileWsServerFrame,
} from '@dash/mobile-contract';
import type {
  MobileV2SequencedFrame,
  MobileV2WsClientFrame,
  MobileV2WsServerFrame,
} from '@dash/mobile-contract-v2';
import type { AgentChatCoordinator } from './agent-chat-coordinator.js';
import { toClientLocation, toClientLocationV2 } from './client-location.js';
import type { ConversationAutoTitleService } from './conversation-auto-title.js';
import { mapConversationV1 } from './conversation-contract-mappers.js';
import type {
  AcceptedRun,
  CommandMutationResult,
  FinishRunInput,
  PersistedRunFrames,
  StoredConversation,
} from './conversation-domain.js';
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
  enqueueInput(
    frame: Extract<MobileV2WsClientFrame, { type: 'enqueue_input' }>,
    sink: V2ConversationFrameSink,
  ): Promise<void>;
  editFollowUp(
    frame: Extract<MobileV2WsClientFrame, { type: 'edit_follow_up' }>,
    sink: V2ConversationFrameSink,
  ): Promise<void>;
  removeFollowUp(
    frame: Extract<MobileV2WsClientFrame, { type: 'remove_follow_up' }>,
    sink: V2ConversationFrameSink,
  ): Promise<void>;
  resumeFollowUps(
    frame: Extract<MobileV2WsClientFrame, { type: 'resume_follow_ups' }>,
    sink: V2ConversationFrameSink,
  ): Promise<void>;
  resumeRecoveredQueues(conversationIds: readonly string[]): Promise<void>;
  suspend(): Promise<void>;
  detach(sink: V1TurnFrameSink | V2ConversationFrameSink): void;
  cancelAgent(agentId: string): Promise<void>;
  allowAgent(agentId: string): void;
  stop(): Promise<void>;
}

type TerminalIntent =
  | { outcome: 'completed'; suppressPromotion: boolean }
  | { outcome: 'cancelled'; suppressPromotion: boolean }
  | { outcome: 'interrupted'; suppressPromotion: true }
  | {
      outcome: 'failed';
      error: string;
      code?: MobileApiErrorCode;
      retryable: boolean;
      suppressPromotion: boolean;
    };

type ExecutionResult = { outcome: 'completed' } | { outcome: 'failed'; error: unknown };

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
  providerFinished: boolean;
  executionStarted: boolean;
  executionPromise: Promise<ExecutionResult>;
  terminalIntent?: TerminalIntent;
  terminalAttempt?: Promise<void>;
  terminalPreparation?: Promise<void>;
  sealedInputIds?: readonly string[];
  backendRejectedInputIds: Set<string>;
  consumptionFailureInputIds: Set<string>;
  pendingAdmissions: Set<Promise<void>>;
  backendStopSignalled: boolean;
  lastV1Seq: number;
  lastV2Seq: number;
  serializedTail: Promise<void>;
  promise: Promise<void>;
  resolvePromise(): void;
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
  queue: Array<{ operation: () => void; resolve(): void }>;
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
  const v1SinkVersions = new WeakMap<V1TurnFrameSink, number>();
  const v2Subscriptions = new Map<string, Set<V2Subscription>>();
  const v2SubscriptionBySink = new Map<V2ConversationFrameSink, V2Subscription>();
  const pendingV2SubscriptionBySink = new Map<V2ConversationFrameSink, V2Subscription>();
  const v2SubscriptionVersions = new WeakMap<V2ConversationFrameSink, number>();
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

  const bumpV1SinkVersion = (sink: V1TurnFrameSink): number => {
    const version = (v1SinkVersions.get(sink) ?? 0) + 1;
    v1SinkVersions.set(sink, version);
    return version;
  };

  const removeV1Sink = (sink: V1TurnFrameSink, expectedKey?: string): void => {
    const key = v1RunBySink.get(sink);
    if (!key || (expectedKey !== undefined && key !== expectedKey)) return;
    v1RunBySink.delete(sink);
    liveRuns.get(key)?.v1Subscribers.delete(sink);
    bumpV1SinkVersion(sink);
  };

  const attachV1Sink = (live: LiveRun, sink: V1TurnFrameSink): void => {
    removeV1Sink(sink);
    const key = liveRunKey(live.agentId, live.conversationId);
    live.v1Subscribers.add(sink);
    v1RunBySink.set(sink, key);
    bumpV1SinkVersion(sink);
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
    const bindings = [...live.v1Subscribers].map((sink) => ({
      sink,
      version: v1SinkVersions.get(sink) ?? 0,
    }));
    for (const { sink, version } of bindings) {
      if (v1RunBySink.get(sink) !== key || v1SinkVersions.get(sink) !== version) continue;
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

  const queueOutbound = (conversationId: string, operation: () => void): Promise<void> =>
    new Promise<void>((resolve) => {
      let state = outboundByConversation.get(conversationId);
      if (!state) {
        state = { draining: false, queue: [] };
        outboundByConversation.set(conversationId, state);
      }
      state.queue.push({ operation, resolve });
      if (state.draining) return;
      state.draining = true;
      try {
        while (state.queue.length > 0) {
          const queued = state.queue.shift();
          if (!queued) continue;
          try {
            queued.operation();
          } catch {
            // Durable storage is authoritative. One observer/sink operation must
            // not strand later committed frames in this conversation's queue.
          } finally {
            queued.resolve();
          }
        }
      } finally {
        state.draining = false;
        if (state.queue.length === 0) outboundByConversation.delete(conversationId);
      }
    });

  const broadcastRunFramesNow = (live: LiveRun, persisted: PersistedRunFrames): void => {
    const v1Frame = frameFromV1Payload(
      live.runId,
      live.conversationId,
      persisted.v1Seq,
      persisted.v1Payload,
    );
    broadcastV1Now(live, v1Frame);
    broadcastV2Now(persisted.v2Frame);
    live.lastV1Seq = Math.max(live.lastV1Seq, persisted.v1Seq);
    live.lastV2Seq = Math.max(live.lastV2Seq, persisted.v2Frame.v2Seq);
  };

  const broadcastRunFrames = (live: LiveRun, persisted: PersistedRunFrames): void => {
    void queueOutbound(live.conversationId, () => broadcastRunFramesNow(live, persisted));
  };

  const publishRunTransaction = (
    live: LiveRun,
    persisted: PersistedRunFrames,
    additionalV2Frames: readonly MobileV2SequencedFrame[] = [],
    afterPublish?: () => void,
  ): Promise<void> =>
    queueOutbound(live.conversationId, () => {
      notifyChanged(persisted.conversation);
      broadcastRunFramesNow(live, persisted);
      for (const frame of additionalV2Frames) broadcastV2Now(frame);
      afterPublish?.();
    });

  const publishV2Transaction = (
    conversation: StoredConversation,
    frames: readonly MobileV2WsServerFrame[],
    afterPublish?: () => void,
  ): Promise<void> =>
    queueOutbound(conversation.id, () => {
      notifyChanged(conversation);
      for (const frame of frames) {
        if ('v2Seq' in frame) broadcastV2Now(frame);
      }
      afterPublish?.();
    });

  const replayV1 = (
    agentId: string,
    conversationId: string,
    sinceSeq: number,
    sink: V1TurnFrameSink,
    expectedVersion: number,
  ): boolean => {
    for (const entry of conversations.eventLog.readSince(agentId, conversationId, sinceSeq)) {
      if (v1SinkVersions.get(sink) !== expectedVersion) return false;
      if (!sendV1(sink, frameFromEntry(entry))) return false;
      if (v1SinkVersions.get(sink) !== expectedVersion) return false;
    }
    return v1SinkVersions.get(sink) === expectedVersion;
  };

  const attachV1IfLive = (
    runId: string,
    agentId: string,
    conversationId: string,
    sink: V1TurnFrameSink,
    expectedVersion: number,
  ): void => {
    if (v1SinkVersions.get(sink) !== expectedVersion) return;
    const conversation = conversations.get(conversationId);
    const live = liveRuns.get(liveRunKey(agentId, conversationId));
    if (
      v1SinkVersions.get(sink) === expectedVersion &&
      conversation?.activeTurnId === runId &&
      live?.runId === runId &&
      !live.terminal
    ) {
      attachV1Sink(live, sink);
    }
  };

  const retireLiveRun = (live: LiveRun): Array<{ sink: V1TurnFrameSink; version: number }> => {
    const key = liveRunKey(live.agentId, live.conversationId);
    if (liveRuns.get(key) === live) liveRuns.delete(key);
    const bindings = [...live.v1Subscribers]
      .filter((sink) => v1RunBySink.get(sink) === key)
      .map((sink) => ({ sink, version: v1SinkVersions.get(sink) ?? 0 }));
    for (const { sink } of bindings) {
      v1RunBySink.delete(sink);
    }
    live.v1Subscribers.clear();
    return bindings;
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

  const assertCurrentV1Binding = (live: LiveRun, sink: V1TurnFrameSink): void => {
    if (v1RunBySink.get(sink) !== liveRunKey(live.agentId, live.conversationId)) {
      throw new ConversationServiceError('not_found', `Run ${live.runId} is not live`, 404, false);
    }
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

  const assertCurrentV2Subscription = (
    sink: V2ConversationFrameSink,
    expected: V2Subscription,
  ): void => {
    if (v2SubscriptionBySink.get(sink) !== expected) {
      throw new ConversationServiceError(
        'not_found',
        'V2 sink is not subscribed to this conversation',
        404,
        false,
      );
    }
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
    const promise = new Promise<void>((resolve) => {
      resolvePromise = resolve;
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
      providerFinished: false,
      executionStarted: false,
      executionPromise: Promise.resolve({ outcome: 'completed' }),
      backendRejectedInputIds: new Set(),
      consumptionFailureInputIds: new Set(),
      pendingAdmissions: new Set(),
      backendStopSignalled: false,
      lastV1Seq: accepted.v1Seq,
      lastV2Seq: accepted.v2Frame.v2Seq,
      serializedTail: Promise.resolve(),
      promise,
      resolvePromise,
    };
  };

  const installLiveRun = (accepted: AcceptedRun, v1Sink?: V1TurnFrameSink): LiveRun => {
    const live = createLiveRun(accepted);
    liveRuns.set(liveRunKey(live.agentId, live.conversationId), live);
    if (v1Sink) attachV1Sink(live, v1Sink);
    return live;
  };

  const scheduleAutoTitle = (live: LiveRun, accepted: AcceptedRun): void => {
    if (!accepted.firstUserMessage) return;
    try {
      options.autoTitle.schedule({
        conversationId: live.conversationId,
        agentId: live.agentId,
        text: accepted.text,
      });
    } catch {
      // Accepted storage is authoritative; title work cannot strand a run.
    }
  };

  const signalBackendStop = (live: LiveRun): void => {
    if (live.backendStopSignalled) return;
    live.backendStopSignalled = true;
    live.controller.abort();
    try {
      agents.cancel(live.agentId, live.conversationId);
    } catch {
      // The generator cleanup below remains the authoritative completion barrier.
    }
  };

  const terminalRank = (intent: TerminalIntent): number => {
    switch (intent.outcome) {
      case 'completed':
        return 0;
      case 'failed':
        return 1;
      case 'cancelled':
        return 2;
      case 'interrupted':
        return 3;
    }
  };

  const mergeTerminalIntent = (live: LiveRun, intent: TerminalIntent): TerminalIntent => {
    const previous = live.terminalIntent;
    if (!previous || terminalRank(intent) > terminalRank(previous)) {
      live.terminalIntent = intent;
    } else if (intent.suppressPromotion && !previous.suppressPromotion) {
      live.terminalIntent = { ...previous, suppressPromotion: true } as TerminalIntent;
    }
    return live.terminalIntent;
  };

  const handleSteerConsumed = async (live: LiveRun, inputId: string): Promise<void> => {
    try {
      await withLiveRunLock(live, async () => {
        if (live.terminal) {
          throw new ConversationServiceError(
            'revision_conflict',
            `Run ${live.runId} is no longer active`,
            409,
            false,
          );
        }
        const delivered = conversations.deliverSteer({
          conversationId: live.conversationId,
          runId: live.runId,
          inputId,
        });
        live.currentSegmentTurnId = delivered.segmentTurnId;
        await publishV2Transaction(delivered.conversation, [delivered.frame]);
      });
    } catch (error) {
      live.consumptionFailureInputIds.add(inputId);
      live.backendRejectedInputIds.add(inputId);
      live.cancelRequested = true;
      const intent: TerminalIntent = {
        outcome: 'failed',
        error: error instanceof Error ? error.message : String(error),
        retryable: false,
        suppressPromotion: false,
      };
      mergeTerminalIntent(live, intent);
      signalBackendStop(live);
      void Promise.resolve()
        .then(() => requestTerminal(live, intent))
        .catch(() => {});
      throw error;
    }
  };

  const runLive = async (
    live: LiveRun,
    accepted: AcceptedRun,
    location?: ClientLocation,
  ): Promise<ExecutionResult> => {
    let stream: ReturnType<AgentChatCoordinator['chat']> | undefined;
    let providerError: unknown;
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
        live.terminalIntent !== undefined ||
        live.terminal ||
        liveRuns.get(liveRunKey(live.agentId, live.conversationId)) !== live
      ) {
        live.providerFinished = true;
        live.settled = true;
        return { outcome: 'completed' };
      }
      stream = agents.chat({
        agentId: live.agentId,
        conversationId: live.conversationId,
        runId: live.runId,
        channelId: live.channelId,
        text: accepted.text,
        images: accepted.images?.map((image) => ({ type: 'image' as const, ...image })),
        location,
        messageId: accepted.userMessage.id,
        signal: live.controller.signal,
        deliveredSteers,
        onSteerConsumed: (inputId) => handleSteerConsumed(live, inputId),
      });
      while (!live.controller.signal.aborted) {
        const result = await stream.next();
        if (result.done) break;
        const event = result.value;
        if (event.type === 'error') throw event.error;
        await withLiveRunLock(live, () => {
          if (live.terminal || live.terminalIntent !== undefined) return;
          const persisted = conversations.appendRunEvent({
            conversationId: live.conversationId,
            runId: live.runId,
            segmentTurnId: live.currentSegmentTurnId,
            event,
          });
          if (persisted) broadcastRunFrames(live, persisted);
        });
      }
    } catch (error) {
      providerError = error;
    }

    live.providerFinished = true;
    const result: ExecutionResult =
      providerError === undefined
        ? { outcome: 'completed' }
        : { outcome: 'failed', error: providerError };
    mergeTerminalIntent(
      live,
      result.outcome === 'completed'
        ? { outcome: 'completed', suppressPromotion: false }
        : {
            outcome: 'failed',
            error: result.error instanceof Error ? result.error.message : String(result.error),
            retryable: false,
            suppressPromotion: false,
          },
    );
    let preparationError: unknown;
    try {
      await ensureTerminalPrepared(live);
    } catch (error) {
      preparationError = error;
    }
    if (stream) await stream.return(undefined);
    live.settled = true;
    if (preparationError !== undefined) throw preparationError;
    return result;
  };

  const beginLiveRun = (live: LiveRun, accepted: AcceptedRun, location?: ClientLocation): void => {
    if (live.executionStarted || live.terminal) return;
    if (live.terminalIntent !== undefined || live.cancelRequested) {
      live.providerFinished = true;
      live.settled = true;
      return;
    }
    live.executionStarted = true;
    const execution = runLive(live, accepted, location);
    live.executionPromise = execution;
    void execution
      .then((result) => {
        const intent: TerminalIntent =
          result.outcome === 'completed'
            ? { outcome: 'completed', suppressPromotion: false }
            : {
                outcome: 'failed',
                error: result.error instanceof Error ? result.error.message : String(result.error),
                retryable: false,
                suppressPromotion: false,
              };
        return requestTerminal(live, intent);
      })
      .catch(() => {
        // Cleanup/storage failures leave the durable lease and LiveRun available
        // for an explicit retry or lifecycle recovery.
      });
  };

  const activateLiveRun = (
    live: LiveRun,
    accepted: AcceptedRun,
    location?: ClientLocation,
  ): void => {
    scheduleAutoTitle(live, accepted);
    beginLiveRun(live, accepted, location);
  };

  const registerAcceptedRun = (
    accepted: AcceptedRun,
    location?: ClientLocation,
    v1Sink?: V1TurnFrameSink,
  ): LiveRun => {
    const live = installLiveRun(accepted, v1Sink);
    void publishRunTransaction(live, acceptedFrames(accepted), [], () => {
      activateLiveRun(live, accepted, location);
    });
    return live;
  };

  const catchUpRunJournals = (live: LiveRun): Promise<void> => {
    const v1Entries = conversations.eventLog
      .readSince(live.agentId, live.conversationId, live.lastV1Seq)
      .filter((entry) => entry.msgId === live.runId);
    const v2Frames = conversations
      .readV2Since(live.agentId, live.conversationId, live.lastV2Seq)
      .frames.filter(
        (frame) => 'runId' in frame && frame.runId === live.runId && frame.v2Seq > live.lastV2Seq,
      );
    if (v1Entries.length === 0 && v2Frames.length === 0) return Promise.resolve();
    return queueOutbound(live.conversationId, () => {
      for (const entry of v1Entries) {
        if (entry.seq <= live.lastV1Seq) continue;
        broadcastV1Now(live, frameFromEntry(entry));
        live.lastV1Seq = Math.max(live.lastV1Seq, entry.seq);
      }
      for (const frame of v2Frames) {
        if (frame.v2Seq <= live.lastV2Seq) continue;
        broadcastV2Now(frame);
        live.lastV2Seq = Math.max(live.lastV2Seq, frame.v2Seq);
      }
    });
  };

  const scheduleCompletedRunWork = (live: LiveRun): void => {
    for (const service of [options.memorySweep, options.skillReview]) {
      try {
        service?.schedule({
          agentId: live.agentId,
          conversationId: live.conversationId,
          runId: live.runId,
        });
      } catch {
        // Post-commit learning observers cannot reverse the terminal transaction.
      }
    }
  };

  const terminalFailure = (intent: TerminalIntent): { code: MobileApiErrorCode; error: string } => {
    switch (intent.outcome) {
      case 'interrupted':
        return {
          code: 'gateway_offline',
          error: 'Gateway stopped before this Steer could be delivered.',
        };
      case 'failed':
        return {
          code: intent.code ?? 'validation_failed',
          error: intent.error,
        };
      case 'cancelled':
        return {
          code: 'validation_failed',
          error: 'Run was cancelled before this Steer could be delivered.',
        };
      case 'completed':
        return {
          code: 'validation_failed',
          error: 'Run completed before this Steer could be delivered.',
        };
    }
  };

  async function prepareTerminal(live: LiveRun): Promise<void> {
    await withLiveRunLock(live, () => {
      if (live.terminal) return;
      live.admissionOpen = false;
    });

    while (live.pendingAdmissions.size > 0) {
      await Promise.allSettled([...live.pendingAdmissions]);
    }
    if (live.terminal) return;

    if (live.sealedInputIds === undefined) {
      const sealed = await agents.sealSteering(live.agentId, live.conversationId, live.runId);
      live.sealedInputIds = [...new Set([...sealed, ...live.backendRejectedInputIds])];
    }

    const inputIds = [...new Set([...live.sealedInputIds, ...live.backendRejectedInputIds])];
    if (inputIds.length === 0) return;
    await withLiveRunLock(live, async () => {
      if (live.terminal) return;
      const intent = live.terminalIntent ?? { outcome: 'completed', suppressPromotion: false };
      const failure = terminalFailure(intent);
      const transitions = conversations.terminalizeSteersNotDelivered({
        conversationId: live.conversationId,
        runId: live.runId,
        inputIds,
        ...failure,
      });
      if (transitions.length > 0) {
        const conversation = transitions.at(-1)?.conversation;
        if (conversation) {
          await publishV2Transaction(
            conversation,
            transitions.map((transition) => transition.frame),
          );
        }
      }
      for (const inputId of inputIds) live.backendRejectedInputIds.delete(inputId);
    });
  }

  function ensureTerminalPrepared(live: LiveRun): Promise<void> {
    if (live.terminalPreparation) return live.terminalPreparation;
    const preparation = prepareTerminal(live);
    live.terminalPreparation = preparation;
    void preparation.catch(() => {
      if (live.terminalPreparation === preparation) live.terminalPreparation = undefined;
    });
    return preparation;
  }

  const finishLiveRun = async (live: LiveRun): Promise<void> => {
    await withLiveRunLock(live, async () => {
      if (live.terminal) return;
      const intent = live.terminalIntent ?? { outcome: 'completed', suppressPromotion: false };
      const agentAccepting =
        !stopped && !quiescingAgents.has(live.agentId) && options.isAgentEnabled(live.agentId);
      const suppressPromotion = intent.suppressPromotion || !agentAccepting;
      const input: FinishRunInput = {
        conversationId: live.conversationId,
        runId: live.runId,
        segmentTurnId: live.currentSegmentTurnId,
        ...(intent.outcome === 'failed'
          ? {
              outcome: 'failed' as const,
              error: intent.error,
              ...(intent.code !== undefined ? { code: intent.code } : {}),
              retryable: intent.retryable,
            }
          : { outcome: intent.outcome }),
        suppressPromotion,
      };
      const result = conversations.finishRunAndClaimNext(input);

      live.terminal = true;
      live.admissionOpen = false;
      const legacySinks = retireLiveRun(live);
      const claimedLive = result.claimedRun ? installLiveRun(result.claimedRun) : undefined;
      await queueOutbound(live.conversationId, () => {
        notifyChanged(result.terminal.conversation);
        const terminalV1 = frameFromV1Payload(
          live.runId,
          live.conversationId,
          result.terminal.v1Seq,
          result.terminal.v1Payload,
        );
        for (const { sink, version } of legacySinks) {
          if (v1SinkVersions.get(sink) !== version || v1RunBySink.has(sink)) continue;
          sendV1(sink, terminalV1);
        }
        live.lastV1Seq = Math.max(live.lastV1Seq, result.terminal.v1Seq);
        broadcastV2Now(result.terminal.v2Frame);
        live.lastV2Seq = Math.max(live.lastV2Seq, result.terminal.v2Frame.v2Seq);
        for (const transition of result.transitions) broadcastV2Now(transition.frame);
        if (result.claimedRun && claimedLive) {
          broadcastV2Now(result.claimedRun.v2Frame);
          if (intent.outcome === 'completed') scheduleCompletedRunWork(live);
          activateLiveRun(claimedLive, result.claimedRun);
        } else if (intent.outcome === 'completed') {
          scheduleCompletedRunWork(live);
        }
      });
      live.resolvePromise();
    });
  };

  const terminalizeLive = async (live: LiveRun): Promise<void> => {
    await ensureTerminalPrepared(live);

    if (!live.settled && !live.providerFinished) signalBackendStop(live);
    if (live.executionStarted && !live.settled) await live.executionPromise;
    if (!live.settled) live.settled = true;
    await catchUpRunJournals(live);
    await finishLiveRun(live);
  };

  function requestTerminal(live: LiveRun, intent: TerminalIntent): Promise<void> {
    mergeTerminalIntent(live, intent);
    if (live.terminal) return Promise.resolve();
    if (live.terminalAttempt) return live.terminalAttempt;
    const attempt = terminalizeLive(live);
    live.terminalAttempt = attempt;
    void attempt.catch(() => {
      if (live.terminalAttempt === attempt) live.terminalAttempt = undefined;
    });
    return attempt;
  }

  const cancelLive = (live: LiveRun, suppressPromotion = false): Promise<void> => {
    live.cancelRequested = true;
    return requestTerminal(live, { outcome: 'cancelled', suppressPromotion });
  };

  const sendCommandResult = (
    result: CommandMutationResult,
    sink: V2ConversationFrameSink,
    subscription: V2Subscription,
  ): void => {
    for (const frame of result.frames) {
      if (v2SubscriptionBySink.get(sink) !== subscription) return;
      if (sendV2(sink, frame)) continue;
      if (v2SubscriptionBySink.get(sink) === subscription) {
        removeV2Subscription(subscription);
      }
      return;
    }
  };

  const publishCommandResult = async (
    result: CommandMutationResult,
    sink: V2ConversationFrameSink,
    subscription: V2Subscription,
  ): Promise<LiveRun | undefined> => {
    if (result.replayed || !result.conversation) {
      sendCommandResult(result, sink, subscription);
      return undefined;
    }
    const claimedLive = result.promotedRun ? installLiveRun(result.promotedRun) : undefined;
    await publishV2Transaction(result.conversation, result.frames, () => {
      if (claimedLive && result.promotedRun) activateLiveRun(claimedLive, result.promotedRun);
    });
    return claimedLive;
  };

  const terminalizeBackendRejectedSteer = async (
    live: LiveRun,
    inputId: string,
    error: string,
  ): Promise<void> => {
    live.backendRejectedInputIds.add(inputId);
    await withLiveRunLock(live, async () => {
      const transitions = conversations.terminalizeSteersNotDelivered({
        conversationId: live.conversationId,
        runId: live.runId,
        inputIds: [inputId],
        code: 'validation_failed',
        error,
      });
      if (transitions.length > 0) {
        const conversation = transitions.at(-1)?.conversation;
        if (conversation) {
          await publishV2Transaction(
            conversation,
            transitions.map((transition) => transition.frame),
          );
        }
      }
      live.backendRejectedInputIds.delete(inputId);
    });
  };

  const startSteerAdmission = (
    live: LiveRun,
    frame: Extract<MobileV2WsClientFrame, { type: 'enqueue_input' }>,
  ): Promise<void> => {
    const admission = Promise.resolve().then(async () => {
      let result: Awaited<ReturnType<AgentChatCoordinator['steerRun']>>;
      try {
        result = await agents.steerRun(
          live.agentId,
          live.conversationId,
          live.runId,
          frame.inputId,
          {
            text: frame.text,
            ...(frame.images !== undefined
              ? { images: frame.images.map((image) => ({ type: 'image' as const, ...image })) }
              : {}),
          },
        );
      } catch (error) {
        if (live.consumptionFailureInputIds.has(frame.inputId)) {
          live.consumptionFailureInputIds.delete(frame.inputId);
          throw error;
        }
        await terminalizeBackendRejectedSteer(
          live,
          frame.inputId,
          error instanceof Error ? error.message : String(error),
        );
        return;
      }
      if (result.accepted) return;
      await terminalizeBackendRejectedSteer(
        live,
        frame.inputId,
        `Steer was not accepted by the active run: ${result.reason}`,
      );
    });
    live.pendingAdmissions.add(admission);
    void admission.then(
      () => live.pendingAdmissions.delete(admission),
      () => live.pendingAdmissions.delete(admission),
    );
    return admission;
  };

  const canAdmitSteer = (live: LiveRun | undefined): live is LiveRun =>
    live?.admissionOpen === true &&
    !live.cancelRequested &&
    live.terminalIntent === undefined &&
    !live.terminal;

  const settleAll = async (operations: readonly Promise<void>[]): Promise<void> => {
    const results = await Promise.allSettled(operations);
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'Failed to settle live runs');
  };

  const quiescingIntent = (
    live: LiveRun,
    fallback: 'cancelled' | 'interrupted',
  ): TerminalIntent => {
    if (live.terminalIntent) {
      return { ...live.terminalIntent, suppressPromotion: true } as TerminalIntent;
    }
    return fallback === 'interrupted'
      ? { outcome: 'interrupted', suppressPromotion: true }
      : { outcome: 'cancelled', suppressPromotion: true };
  };

  const startAccepted = (
    protocol: 'v1' | 'v2',
    frame: ResumableSendFrame | Extract<MobileV2WsClientFrame, { type: 'message' }>,
    v1Sink?: V1TurnFrameSink,
    v2Sink?: V2ConversationFrameSink,
  ): void => {
    assertAgentAccepting(frame.agentId);
    const v2Subscription =
      protocol === 'v2' && v2Sink
        ? requireV2Subscription(v2Sink, frame.conversationId, frame.agentId)
        : undefined;
    let location: ClientLocation | undefined;
    if (protocol === 'v2' && Object.hasOwn(frame, 'location')) {
      location = toClientLocationV2(frame.location);
      if (location === undefined) {
        throw new ConversationServiceError(
          'validation_failed',
          'Location must be a valid v2 client location',
          400,
          false,
        );
      }
    } else if (protocol === 'v1') {
      location = toClientLocation(frame.location);
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
        const version = bumpV1SinkVersion(v1Sink);
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
          v1SinkVersions.get(v1Sink) === version &&
          replayV1(
            accepted.conversation.agentId,
            accepted.conversation.id,
            accepted.v1Seq,
            v1Sink,
            version,
          )
        ) {
          attachV1IfLive(
            accepted.runId,
            accepted.conversation.agentId,
            accepted.conversation.id,
            v1Sink,
            version,
          );
        }
      } else if (protocol === 'v2' && v2Sink) {
        if (
          !sendV2(v2Sink, accepted.v2Frame) &&
          v2SubscriptionBySink.get(v2Sink) === v2Subscription &&
          v2Subscription
        ) {
          removeV2Subscription(v2Subscription);
        }
      }
      return;
    }
    registerAcceptedRun(accepted, location, v1Sink);
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
      const version = bumpV1SinkVersion(sink);
      if (!replayV1(frame.agentId, frame.conversationId, frame.sinceSeq, sink, version)) return;
      attachV1IfLive(frame.id, frame.agentId, frame.conversationId, sink, version);
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
        if (live.terminal || live.terminalIntent !== undefined) {
          throw new ConversationServiceError('not_found', `Run ${runId} is not live`, 404, false);
        }
        if (sink) assertCurrentV1Binding(live, sink);
        await agents.answerQuestion(live.agentId, live.conversationId, questionId, answer);
      });
    },

    async answerV2(frame, sink) {
      assertAccepting();
      const subscription = requireV2Subscription(sink);
      const live = requireV2LiveRun(frame.id, sink);
      await withLiveRunLock(live, async () => {
        if (live.terminal || live.terminalIntent !== undefined) {
          throw new ConversationServiceError(
            'not_found',
            `Run ${frame.id} is not live`,
            404,
            false,
          );
        }
        assertCurrentV2Subscription(sink, subscription);
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
      await cancelLive(live);
    },

    async cancelV2(frame, sink) {
      assertAccepting();
      const live = requireV2LiveRun(frame.id, sink);
      await cancelLive(live);
    },

    async enqueueInput(frame, sink) {
      const subscription = requireV2Subscription(sink, frame.conversationId, frame.agentId);
      assertAgentAccepting(frame.agentId);
      const key = liveRunKey(subscription.agentId, subscription.conversationId);
      const live = liveRuns.get(key);
      let admission: Promise<void> | undefined;
      const mutate = async (): Promise<void> => {
        assertAgentAccepting(frame.agentId);
        if (live) await catchUpRunJournals(live);
        assertCurrentV2Subscription(sink, subscription);
        const result = conversations.enqueueInput(
          {
            commandId: frame.id,
            inputId: frame.inputId,
            agentId: frame.agentId,
            channelId: frame.channelId,
            conversationId: frame.conversationId,
            text: frame.text,
            images: frame.images,
            behavior: frame.behavior,
            expectedActiveTurnId: frame.expectedActiveTurnId,
          },
          { steerAdmissionOpen: canAdmitSteer(live) },
        );
        await publishCommandResult(result, sink, subscription);
        if (
          frame.behavior === 'steer' &&
          live &&
          !result.replayed &&
          result.conversation !== undefined
        ) {
          if (canAdmitSteer(live)) admission = startSteerAdmission(live, frame);
          else live.backendRejectedInputIds.add(frame.inputId);
        }
      };
      if (live) await withLiveRunLock(live, mutate);
      else await mutate();
      if (admission) {
        await admission.catch(() => {
          // The command is already durably accepted. Admission/terminalization
          // failure is retained on the LiveRun for terminal recovery and must
          // never be reclassified by the caller as command_rejected.
        });
      }
    },

    async editFollowUp(frame, sink) {
      assertAccepting();
      const subscription = requireV2Subscription(sink, frame.conversationId);
      const live = liveRuns.get(liveRunKey(subscription.agentId, subscription.conversationId));
      const mutate = async (): Promise<void> => {
        assertAccepting();
        if (live) await catchUpRunJournals(live);
        assertCurrentV2Subscription(sink, subscription);
        const result = conversations.editFollowUp({
          commandId: frame.id,
          conversationId: frame.conversationId,
          inputId: frame.inputId,
          expectedRevision: frame.expectedRevision,
          text: frame.text,
          images: frame.images,
        });
        await publishCommandResult(result, sink, subscription);
      };
      if (live) await withLiveRunLock(live, mutate);
      else await mutate();
    },

    async removeFollowUp(frame, sink) {
      assertAccepting();
      const subscription = requireV2Subscription(sink, frame.conversationId);
      const live = liveRuns.get(liveRunKey(subscription.agentId, subscription.conversationId));
      const mutate = async (): Promise<void> => {
        assertAccepting();
        if (live) await catchUpRunJournals(live);
        assertCurrentV2Subscription(sink, subscription);
        const result = conversations.removeFollowUp({
          commandId: frame.id,
          conversationId: frame.conversationId,
          inputId: frame.inputId,
          expectedRevision: frame.expectedRevision,
        });
        await publishCommandResult(result, sink, subscription);
      };
      if (live) await withLiveRunLock(live, mutate);
      else await mutate();
    },

    async resumeFollowUps(frame, sink) {
      const subscription = requireV2Subscription(sink, frame.conversationId);
      assertAgentAccepting(subscription.agentId);
      const live = liveRuns.get(liveRunKey(subscription.agentId, frame.conversationId));
      const mutate = async (): Promise<void> => {
        assertAgentAccepting(subscription.agentId);
        if (live) await catchUpRunJournals(live);
        assertCurrentV2Subscription(sink, subscription);
        const result = conversations.resumeFollowUps({
          commandId: frame.id,
          conversationId: frame.conversationId,
          expectedQueueRevision: frame.expectedQueueRevision,
        });
        await publishCommandResult(result, sink, subscription);
      };
      if (live) await withLiveRunLock(live, mutate);
      else await mutate();
    },

    async resumeRecoveredQueues(conversationIds) {
      assertAccepting();
      for (const conversationId of new Set(conversationIds)) {
        const conversation = conversations.get(conversationId);
        if (!conversation) {
          throw new ConversationServiceError(
            'not_found',
            `Conversation ${conversationId} was not found`,
            404,
            false,
          );
        }
        assertAgentAccepting(conversation.agentId);
        const key = liveRunKey(conversation.agentId, conversationId);
        if (liveRuns.has(key)) continue;
        assertAgentAccepting(conversation.agentId);
        const claimed = conversations.claimNextFollowUp(conversationId);
        if (!claimed) continue;
        const live = installLiveRun(claimed.run);
        await publishV2Transaction(
          claimed.run.conversation,
          [claimed.transition.frame, claimed.run.v2Frame],
          () => activateLiveRun(live, claimed.run),
        );
      }
    },

    async suspend() {
      stopped = true;
      const active = [...liveRuns.values()];
      for (const live of active) live.cancelRequested = true;
      await settleAll(
        active.map((live) => requestTerminal(live, quiescingIntent(live, 'interrupted'))),
      );
    },

    detach(sink) {
      const v1Sink = sink as V1TurnFrameSink;
      removeV1Sink(v1Sink);
      bumpV1SinkVersion(v1Sink);
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
      for (const live of matching) live.cancelRequested = true;
      await settleAll(
        matching.map((live) => requestTerminal(live, quiescingIntent(live, 'cancelled'))),
      );
    },

    allowAgent(agentId) {
      quiescingAgents.delete(agentId);
    },

    async stop() {
      stopped = true;
      const active = [...liveRuns.values()];
      for (const live of active) live.cancelRequested = true;
      await settleAll(
        active.map((live) => requestTerminal(live, quiescingIntent(live, 'cancelled'))),
      );
    },
  };

  return hub;
}
