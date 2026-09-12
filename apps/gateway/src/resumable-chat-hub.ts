import { randomUUID } from 'node:crypto';
import type { AgentEvent, ClientLocation } from '@dash/agent';
import type {
  ConversationKind,
  ConversationMessageOrigin,
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
import { isTransientAgentEvent } from '@dash/swarm';
import {
  type AdmissionToken,
  GatewayAdmissionController,
  type LifecycleCleanupToken,
} from './admission-controller.js';
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
  admission?: GatewayAdmissionController;
  /** Optional post-turn memory sweep; scheduled only for runs that complete. */
  memorySweep?: Pick<MemorySweepService, 'schedule'>;
  skillReview?: Pick<SkillReviewService, 'schedule'>;
  swarmCoordinator?: {
    cancelTurn(agentId: string, conversationId: string): boolean | Promise<boolean>;
    deliverPending?(agentId: string, conversationId: string): Promise<unknown>;
  };
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
  suspend(cleanupToken?: LifecycleCleanupToken): Promise<void>;
  detach(sink: V1TurnFrameSink | V2ConversationFrameSink): void;
  disableAgent(agentId: string, cleanupToken: LifecycleCleanupToken): Promise<void>;
  deleteAgent(agentId: string, cleanupToken: LifecycleCleanupToken): Promise<void>;
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
  admissionToken: AdmissionToken;
  /** Decides conversation fan-out: only a non-`'user'` turn reaches subscribers. */
  origin: ConversationMessageOrigin;
  /**
   * `'subagent'` for a CHILD conversation's turn. Read only by the post-turn
   * work below, which is the parent's, not the child's.
   */
  kind: ConversationKind;
  /** Live-only client correlation; never written to either replay journal. */
  requestId?: string;
  controller: AbortController;
  v1Subscribers: Set<V1TurnFrameSink>;
  admissionOpen: boolean;
  cancelRequested: boolean;
  terminal: boolean;
  recoveryRequired: boolean;
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
  /** One `onFinish` per turn, whichever path gets there first. */
  finishNotified: boolean;
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

function containsCanonicalSwarmJournalError(
  error: unknown,
  seen: Set<unknown> = new Set(),
): boolean {
  if (!(error instanceof Error) || seen.has(error)) return false;
  seen.add(error);
  if (error.name === 'CanonicalSwarmJournalError') return true;
  if (
    error instanceof AggregateError &&
    error.errors.some((nested) => containsCanonicalSwarmJournalError(nested, seen))
  ) {
    return true;
  }
  return containsCanonicalSwarmJournalError(error.cause, seen);
}

class LiveRunRecoveryRequiredError extends Error {
  override readonly name = 'LiveRunRecoveryRequiredError';
}

class SteerContinuationFencedError extends Error {
  constructor(runId: string) {
    super(`Run ${runId} is no longer accepting Steers`);
    this.name = 'SteerContinuationFencedError';
  }
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

/** Add live-only sub-agent metadata to an accepted v1 frame. */
function acceptedV1Frame(
  runId: string,
  conversationId: string,
  seq: number,
  payload: Extract<EventLogPayload, { type: 'accepted' }>,
  origin: ConversationMessageOrigin,
  kind: ConversationKind,
  requestId?: string,
): MobileWsServerFrame {
  const frame = frameFromV1Payload(runId, conversationId, seq, payload);
  if (frame.type !== 'accepted') return frame;
  const ordinary = origin === 'user' && kind === 'user';
  return {
    ...frame,
    ...(ordinary ? {} : { origin, kind }),
    ...(requestId !== undefined ? { requestId } : {}),
  };
}

type LiveAcceptedV2Frame = Extract<MobileV2SequencedFrame, { type: 'accepted' }> & {
  origin?: ConversationMessageOrigin;
  kind?: ConversationKind;
  requestId?: string;
};

/** Decorate only the live accepted publication; durable replay stays correlation-free. */
function acceptedV2Frame(
  accepted: AcceptedRun,
  origin: ConversationMessageOrigin,
  kind: ConversationKind,
  requestId?: string,
): MobileV2SequencedFrame {
  const ordinary = origin === 'user' && kind === 'user';
  return {
    ...accepted.v2Frame,
    ...(ordinary ? {} : { origin, kind }),
    ...(requestId !== undefined ? { requestId } : {}),
  } as LiveAcceptedV2Frame;
}

export function createResumableChatHub(options: ResumableChatHubOptions): ResumableChatHub {
  const { conversations, agents } = options;
  const admission = options.admission ?? new GatewayAdmissionController();
  const liveRuns = new Map<string, LiveRun>();
  const v1RunBySink = new Map<V1TurnFrameSink, string>();
  const v1SinkVersions = new WeakMap<V1TurnFrameSink, number>();
  const v2Subscriptions = new Map<string, Set<V2Subscription>>();
  const v2SubscriptionBySink = new Map<V2ConversationFrameSink, V2Subscription>();
  const pendingV2SubscriptionBySink = new Map<V2ConversationFrameSink, V2Subscription>();
  const v2SubscriptionVersions = new WeakMap<V2ConversationFrameSink, number>();
  const outboundByConversation = new Map<string, OutboundState>();
  const conversationSubscribers = new Map<string, Set<TurnFrameSink>>();
  const observers = new Set<TurnObserver>();
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

  const assertAdmissionCurrent = (token: AdmissionToken): void => {
    if (admission.isCurrent(token)) return;
    // Prefer the stable public reason for a closed process/agent/conversation.
    admission.capture(token.agentId, token.conversationId);
    throw new Error('Gateway admission changed while the operation was in flight');
  };

  const notifyChanged = (conversation: StoredConversation): void => {
    try {
      options.onChanged?.(mapConversationV1(conversation));
    } catch {
      // The SQLite commit is authoritative. Observer failures cannot reverse it
      // or reclassify the provider outcome.
    }
  };

  const assertOwnedConversation = (agentId: string, conversationId: string): void => {
    const conversation = conversations.get(conversationId);
    if (!conversation || conversation.agentId !== agentId) {
      throw new ConversationServiceError('not_found', 'Conversation not found', 404, false);
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
  const removeConversationSubscriberEverywhere = (sink: TurnFrameSink): void => {
    for (const [key, sinks] of conversationSubscribers) {
      if (!sinks.delete(sink)) continue;
      if (sinks.size === 0) conversationSubscribers.delete(key);
    }
  };

  const observedTurn = (live: LiveRun): ObservedTurn => ({
    agentId: live.agentId,
    conversationId: live.conversationId,
    turnId: live.runId,
  });

  const notifyEvent = (live: LiveRun, event: AgentEvent): void => {
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

  const notifyFinish = (live: LiveRun, outcome: TurnOutcome, error?: string): void => {
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
    const ownBindings = [...live.v1Subscribers].map((sink) => ({
      sink,
      version: v1SinkVersions.get(sink) ?? 0,
    }));
    for (const { sink, version } of ownBindings) {
      if (v1RunBySink.get(sink) !== key || v1SinkVersions.get(sink) !== version) continue;
      if (sendV1(sink, frame)) continue;
      removeV1Sink(sink, key);
      removeConversationSubscriberEverywhere(sink);
    }

    // Explicit/implicit conversation subscriptions receive server-originated
    // turns only. Ordinary user turns stay scoped to the initiating sink.
    if (live.origin === 'user') return;
    const watchers = conversationSubscribers.get(key);
    if (!watchers) return;
    const watcherBindings = [...watchers].map((sink) => ({
      sink,
      version: v1SinkVersions.get(sink) ?? 0,
    }));
    for (const { sink, version } of watcherBindings) {
      if (live.v1Subscribers.has(sink)) continue;
      if (!watchers.has(sink) || (v1SinkVersions.get(sink) ?? 0) !== version) continue;
      if (sendV1(sink, frame)) continue;
      removeV1Sink(sink);
      removeConversationSubscriberEverywhere(sink);
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

  const broadcastRunFramesNow = (
    live: LiveRun,
    persisted: PersistedRunFrames,
    liveAccepted = false,
  ): void => {
    const v1Frame =
      liveAccepted && persisted.v1Payload.type === 'accepted'
        ? acceptedV1Frame(
            live.runId,
            live.conversationId,
            persisted.v1Seq,
            persisted.v1Payload,
            live.origin,
            live.kind,
            live.requestId,
          )
        : frameFromV1Payload(live.runId, live.conversationId, persisted.v1Seq, persisted.v1Payload);
    broadcastV1Now(live, v1Frame);
    broadcastV2Now(
      liveAccepted && persisted.v2Frame.type === 'accepted'
        ? ({
            ...persisted.v2Frame,
            ...(live.origin === 'user' && live.kind === 'user'
              ? {}
              : { origin: live.origin, kind: live.kind }),
            ...(live.requestId !== undefined ? { requestId: live.requestId } : {}),
          } as LiveAcceptedV2Frame)
        : persisted.v2Frame,
    );
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
    liveAccepted = false,
  ): Promise<void> =>
    queueOutbound(live.conversationId, () => {
      notifyChanged(persisted.conversation);
      broadcastRunFramesNow(live, persisted, liveAccepted);
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
    token: AdmissionToken,
  ): boolean => {
    if (!admission.isCurrent(token)) return false;
    for (const entry of conversations.eventLog.readSince(agentId, conversationId, sinceSeq)) {
      if (!admission.isCurrent(token) || v1SinkVersions.get(sink) !== expectedVersion) return false;
      if (!sendV1(sink, frameFromEntry(entry))) return false;
      if (!admission.isCurrent(token) || v1SinkVersions.get(sink) !== expectedVersion) return false;
    }
    return admission.isCurrent(token) && v1SinkVersions.get(sink) === expectedVersion;
  };

  const attachV1IfLive = (
    runId: string,
    agentId: string,
    conversationId: string,
    sink: V1TurnFrameSink,
    expectedVersion: number,
    token: AdmissionToken,
  ): void => {
    if (!admission.isCurrent(token) || v1SinkVersions.get(sink) !== expectedVersion) return;
    const conversation = conversations.get(conversationId);
    const live = liveRuns.get(liveRunKey(agentId, conversationId));
    if (
      admission.isCurrent(token) &&
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

  const createLiveRun = (
    accepted: AcceptedRun,
    token: AdmissionToken,
    origin: ConversationMessageOrigin = accepted.userMessage.origin ?? 'user',
    requestId?: string,
  ): LiveRun => {
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
      admissionToken: token,
      origin,
      kind: accepted.conversation.kind ?? 'user',
      ...(requestId !== undefined ? { requestId } : {}),
      controller: new AbortController(),
      v1Subscribers: new Set(),
      admissionOpen: true,
      cancelRequested: false,
      terminal: false,
      recoveryRequired: false,
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
      finishNotified: false,
      promise,
      resolvePromise,
    };
  };

  const installLiveRun = (
    accepted: AcceptedRun,
    token: AdmissionToken,
    v1Sink?: V1TurnFrameSink,
    origin?: ConversationMessageOrigin,
    requestId?: string,
  ): LiveRun => {
    const live = createLiveRun(accepted, token, origin, requestId);
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

  const recoveryRequiredError = (live: LiveRun): LiveRunRecoveryRequiredError =>
    new LiveRunRecoveryRequiredError(
      `Conversation '${live.conversationId}' requires recovery before terminal cleanup`,
    );

  const assertLiveRecoveryNotRequired = (live: LiveRun): void => {
    if (live.recoveryRequired) throw recoveryRequiredError(live);
  };

  const quarantineCanonicalFailure = (live: LiveRun, error: unknown): boolean => {
    if (!containsCanonicalSwarmJournalError(error)) return false;
    admission.markRecoveryRequired(live.agentId, live.conversationId);
    live.recoveryRequired = true;
    live.settled = true;
    return true;
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
      return intent;
    }
    if (intent.suppressPromotion && !previous.suppressPromotion) {
      const merged = { ...previous, suppressPromotion: true } as TerminalIntent;
      live.terminalIntent = merged;
      return merged;
    }
    return previous;
  };

  const steerConsumptionIsCurrent = (live: LiveRun): boolean =>
    !live.terminal &&
    live.admissionOpen &&
    !live.cancelRequested &&
    live.terminalIntent === undefined &&
    !live.recoveryRequired &&
    admission.isCurrent(live.admissionToken);

  const handleSteerConsumed = async (live: LiveRun, inputId: string): Promise<void> => {
    let deliveryCommitted = false;
    try {
      await withLiveRunLock(live, async () => {
        if (!steerConsumptionIsCurrent(live)) throw new SteerContinuationFencedError(live.runId);
        const delivered = conversations.deliverSteer({
          conversationId: live.conversationId,
          runId: live.runId,
          inputId,
        });
        deliveryCommitted = true;
        live.currentSegmentTurnId = delivered.segmentTurnId;
        await publishV2Transaction(delivered.conversation, [delivered.frame]);
        if (!steerConsumptionIsCurrent(live)) throw new SteerContinuationFencedError(live.runId);
      });
    } catch (error) {
      if (!deliveryCommitted) {
        live.consumptionFailureInputIds.add(inputId);
        live.backendRejectedInputIds.add(inputId);
      }
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
        !admission.isCurrent(live.admissionToken) ||
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
        notifyEvent(live, event);
        if (isTransientAgentEvent(event)) {
          // Spec §7.2: live-stream only. Subscribers still see it, but it is
          // never persisted — hence no seq, and no row for a resume to replay.
          await withLiveRunLock(live, () => {
            if (live.terminal || live.terminalIntent !== undefined) return;
            broadcastV1Now(live, {
              type: 'event',
              id: live.runId,
              conversationId: live.conversationId,
              event,
            });
          });
          continue;
        }
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
    if (providerError !== undefined && quarantineCanonicalFailure(live, providerError)) {
      if (stream) {
        try {
          await stream.return(undefined);
        } catch {
          // The canonical journal failure already owns the outcome. Cleanup is
          // still awaited, but no secondary disposal failure may terminalize it.
        }
      }
      return result;
    }
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
    if (stream) {
      try {
        await stream.return(undefined);
      } catch (error) {
        if (quarantineCanonicalFailure(live, error)) return result;
        throw error;
      }
    }
    live.settled = true;
    if (preparationError !== undefined) throw preparationError;
    return result;
  };

  const beginLiveRun = (live: LiveRun, accepted: AcceptedRun, location?: ClientLocation): void => {
    if (live.executionStarted || live.terminal) return;
    if (
      live.terminalIntent !== undefined ||
      live.cancelRequested ||
      !admission.isCurrent(live.admissionToken)
    ) {
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
    if (!admission.isCurrent(live.admissionToken)) return;
    scheduleAutoTitle(live, accepted);
    if (!admission.isCurrent(live.admissionToken)) return;
    beginLiveRun(live, accepted, location);
  };

  const registerAcceptedRun = (
    accepted: AcceptedRun,
    token: AdmissionToken,
    location?: ClientLocation,
    v1Sink?: V1TurnFrameSink,
    origin?: ConversationMessageOrigin,
    requestId?: string,
  ): LiveRun => {
    const live = installLiveRun(accepted, token, v1Sink, origin, requestId);
    void publishRunTransaction(
      live,
      acceptedFrames(accepted),
      [],
      () => {
        activateLiveRun(live, accepted, location);
      },
      true,
    );
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
    // A child carries its parent's agent id. Sweeping/reviewing it would write
    // the child's transcript into the parent's memory and managed skills.
    if (live.kind === 'subagent') return;
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
      let sealing!: Promise<string[]>;
      try {
        // Starting this call first synchronously records the coordinator's
        // seal request. Interrupt immediately afterwards so a run still stuck
        // in config/readiness can unwind and settle that seal.
        sealing = agents.sealSteering(live.agentId, live.conversationId, live.runId);
      } finally {
        if (!live.settled && !live.providerFinished) signalBackendStop(live);
      }
      const sealed = await sealing;
      // A preparing owner has no safe backend seal to query when cancellation
      // wins readiness. SQLite is authoritative for every durably accepted,
      // still-undelivered Steer, so include those IDs before terminalization.
      const durableSteers = conversations
        .bootstrapV2({ conversationId: live.conversationId, limit: 1 })
        .pendingInputs.filter(
          (input) =>
            input.kind === 'steer' &&
            (input.runId === live.runId || input.targetTurnId === live.runId),
        )
        .map((input) => input.inputId);
      live.sealedInputIds = [
        ...new Set([...sealed, ...durableSteers, ...live.backendRejectedInputIds]),
      ];
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
    let shouldDeliverNotifications = false;
    try {
      await withLiveRunLock(live, async () => {
        if (live.terminal) return;
        const intent = live.terminalIntent ?? { outcome: 'completed', suppressPromotion: false };
        const agentAccepting =
          !stopped &&
          !quiescingAgents.has(live.agentId) &&
          options.isAgentEnabled(live.agentId) &&
          admission.isCurrent(live.admissionToken);
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
        const key = liveRunKey(live.agentId, live.conversationId);
        const conversationWatchers =
          live.origin === 'user'
            ? []
            : [...(conversationSubscribers.get(key) ?? [])]
                .filter((sink) => !live.v1Subscribers.has(sink))
                .map((sink) => ({ sink, version: v1SinkVersions.get(sink) ?? 0 }));
        const legacySinks = retireLiveRun(live);
        const claimedLive = result.claimedRun
          ? installLiveRun(result.claimedRun, live.admissionToken)
          : undefined;
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
            if (sendV1(sink, terminalV1)) continue;
            removeConversationSubscriberEverywhere(sink);
          }
          const currentWatchers = conversationSubscribers.get(key);
          for (const { sink, version } of conversationWatchers) {
            if (!currentWatchers?.has(sink) || (v1SinkVersions.get(sink) ?? 0) !== version) {
              continue;
            }
            if (sendV1(sink, terminalV1)) continue;
            removeConversationSubscriberEverywhere(sink);
          }
          live.lastV1Seq = Math.max(live.lastV1Seq, result.terminal.v1Seq);
          broadcastV2Now(result.terminal.v2Frame);
          live.lastV2Seq = Math.max(live.lastV2Seq, result.terminal.v2Frame.v2Seq);
          for (const transition of result.transitions) broadcastV2Now(transition.frame);
          if (result.claimedRun && claimedLive) {
            broadcastV2Now(
              acceptedV2Frame(
                result.claimedRun,
                claimedLive.origin,
                claimedLive.kind,
                claimedLive.requestId,
              ),
            );
            if (intent.outcome === 'completed') scheduleCompletedRunWork(live);
            activateLiveRun(claimedLive, result.claimedRun);
          } else if (intent.outcome === 'completed') {
            scheduleCompletedRunWork(live);
          }
          notifyFinish(
            live,
            intent.outcome === 'failed'
              ? 'failed'
              : intent.outcome === 'completed'
                ? 'completed'
                : 'cancelled',
            intent.outcome === 'failed' ? intent.error : undefined,
          );
        });
        shouldDeliverNotifications = !result.claimedRun && agentAccepting;
        live.resolvePromise();
      });
    } catch (error) {
      notifyFinish(live, 'failed', error instanceof Error ? error.message : String(error));
      throw error;
    }

    // The durable turn lease is gone and no Follow Up was promoted. Busy
    // attempts leave notification rows untouched; this is the one retry point.
    if (shouldDeliverNotifications) {
      await options.swarmCoordinator?.deliverPending?.(live.agentId, live.conversationId);
    }
  };

  const terminalizeLive = async (live: LiveRun): Promise<void> => {
    assertLiveRecoveryNotRequired(live);
    await ensureTerminalPrepared(live);

    if (live.executionStarted && !live.settled) await live.executionPromise;
    assertLiveRecoveryNotRequired(live);
    if (!live.settled) live.settled = true;
    await catchUpRunJournals(live);
    assertLiveRecoveryNotRequired(live);
    await finishLiveRun(live);
  };

  function requestTerminal(live: LiveRun, intent: TerminalIntent): Promise<void> {
    mergeTerminalIntent(live, intent);
    if (live.recoveryRequired) return Promise.reject(recoveryRequiredError(live));
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
    token: AdmissionToken,
  ): Promise<LiveRun | undefined> => {
    if (result.replayed || !result.conversation) {
      sendCommandResult(result, sink, subscription);
      return undefined;
    }
    const claimedLive = result.promotedRun ? installLiveRun(result.promotedRun, token) : undefined;
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
    token: AdmissionToken,
  ): Promise<void> => {
    const pendingAdmission = Promise.resolve().then(async () => {
      if (!canAdmitSteer(live) || !admission.isCurrent(token)) {
        live.backendRejectedInputIds.add(frame.inputId);
        return;
      }
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
        if (error instanceof SteerContinuationFencedError) throw error;
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
    live.pendingAdmissions.add(pendingAdmission);
    void pendingAdmission.then(
      () => live.pendingAdmissions.delete(pendingAdmission),
      () => live.pendingAdmissions.delete(pendingAdmission),
    );
    return pendingAdmission;
  };

  const canAdmitSteer = (live: LiveRun | undefined): boolean =>
    live?.admissionOpen === true &&
    !live.cancelRequested &&
    live.terminalIntent === undefined &&
    !live.terminal;

  const settleAll = async (
    operations: readonly Promise<void>[],
    aggregateMessage = 'Failed to settle live runs',
  ): Promise<void> => {
    const results = await Promise.allSettled(operations);
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, aggregateMessage);
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
    token: AdmissionToken,
    v1Sink?: V1TurnFrameSink,
    v2Sink?: V2ConversationFrameSink,
    origin: ConversationMessageOrigin = 'user',
    requestId?: string,
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
      origin,
    });
    if (!accepted.created) {
      if (protocol === 'v1' && v1Sink) {
        const version = bumpV1SinkVersion(v1Sink);
        const sent = sendV1(
          v1Sink,
          acceptedV1Frame(
            accepted.runId,
            accepted.conversation.id,
            accepted.v1Seq,
            accepted.v1Payload,
            accepted.userMessage.origin ?? origin,
            accepted.conversation.kind ?? 'user',
            requestId,
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
            token,
          )
        ) {
          addConversationSubscriber(
            liveRunKey(accepted.conversation.agentId, accepted.conversation.id),
            v1Sink,
          );
          attachV1IfLive(
            accepted.runId,
            accepted.conversation.agentId,
            accepted.conversation.id,
            v1Sink,
            version,
            token,
          );
        }
      } else if (protocol === 'v2' && v2Sink) {
        if (
          !sendV2(
            v2Sink,
            acceptedV2Frame(
              accepted,
              accepted.userMessage.origin ?? origin,
              accepted.conversation.kind ?? 'user',
              requestId,
            ),
          ) &&
          v2SubscriptionBySink.get(v2Sink) === v2Subscription &&
          v2Subscription
        ) {
          removeV2Subscription(v2Subscription);
        }
      }
      return;
    }
    if (protocol === 'v1' && v1Sink) {
      addConversationSubscriber(
        liveRunKey(accepted.conversation.agentId, accepted.conversation.id),
        v1Sink,
      );
    }
    registerAcceptedRun(accepted, token, location, v1Sink, origin, requestId);
  };

  const hub: ResumableChatHub = {
    start(frame, sink) {
      assertAgentAccepting(frame.agentId);
      const lease = admission.acquire(frame.agentId, frame.conversationId);
      try {
        startAccepted('v1', frame, lease.token, sink);
      } finally {
        lease.release();
      }
    },

    startV2(frame, sink) {
      assertAgentAccepting(frame.agentId);
      const lease = admission.acquire(frame.agentId, frame.conversationId);
      try {
        startAccepted('v2', frame, lease.token, undefined, sink);
      } finally {
        lease.release();
      }
    },

    resume(frame, sink) {
      const lease = admission.acquire(frame.agentId, frame.conversationId);
      try {
        assertAccepting();
        const conversation = conversations.get(frame.conversationId);
        if (!conversation || conversation.agentId !== frame.agentId) {
          throw new ConversationServiceError('not_found', 'Conversation not found', 404, false);
        }
        const version = bumpV1SinkVersion(sink);
        if (
          !replayV1(frame.agentId, frame.conversationId, frame.sinceSeq, sink, version, lease.token)
        ) {
          return;
        }
        addConversationSubscriber(liveRunKey(frame.agentId, frame.conversationId), sink);
        attachV1IfLive(frame.id, frame.agentId, frame.conversationId, sink, version, lease.token);
      } finally {
        lease.release();
      }
    },

    subscribeConversation(frame, sink) {
      const lease = admission.acquire(frame.agentId, frame.conversationId);
      try {
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
          admission.isCurrent(lease.token) &&
          v2SubscriptionVersions.get(sink) === version &&
          pendingV2SubscriptionBySink.get(sink) === subscription;
        const abandonSupersededReplay = (): boolean => {
          if (replayIsCurrent()) return false;
          removeV2Subscription(subscription);
          return true;
        };

        try {
          if (abandonSupersededReplay()) return;
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
          subscription.deliveredThrough = Math.max(
            subscription.deliveredThrough,
            replay.throughSeq,
          );
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
          } else if (!admission.isCurrent(lease.token)) {
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
      } finally {
        lease.release();
      }
    },

    startSystemTurn({ agentId, conversationId, text, origin, turnId, requestId }) {
      assertAgentAccepting(agentId);
      const id = turnId ?? randomUUID();
      const frame: ResumableSendFrame = {
        type: 'message',
        id,
        agentId,
        channelId: 'system',
        conversationId,
        text,
        resumable: true,
      };
      const lease = admission.acquire(agentId, conversationId);
      try {
        // A busy error intentionally propagates so the durable notification is
        // retried after the current run and all promoted Follow Ups settle.
        startAccepted('v1', frame, lease.token, undefined, undefined, origin, requestId);
      } finally {
        lease.release();
      }
      return { turnId: id };
    },

    subscribe(agentId, conversationId, sink) {
      assertAccepting();
      assertOwnedConversation(agentId, conversationId);
      addConversationSubscriber(liveRunKey(agentId, conversationId), sink);
    },

    unsubscribe(agentId, conversationId, sink) {
      removeConversationSubscriber(liveRunKey(agentId, conversationId), sink);
    },

    addObserver(observer) {
      observers.add(observer);
      return () => {
        observers.delete(observer);
      };
    },

    async answer(runId, questionId, answer, sink) {
      assertAccepting();
      const live = requireLiveRun(runId, sink);
      const lease = admission.acquire(live.agentId, live.conversationId);
      try {
        await withLiveRunLock(live, async () => {
          assertAdmissionCurrent(lease.token);
          if (live.terminal || live.terminalIntent !== undefined) {
            throw new ConversationServiceError('not_found', `Run ${runId} is not live`, 404, false);
          }
          if (sink) assertCurrentV1Binding(live, sink);
          await agents.answerQuestion(live.agentId, live.conversationId, questionId, answer);
        });
      } finally {
        lease.release();
      }
    },

    async answerV2(frame, sink) {
      assertAccepting();
      const subscription = requireV2Subscription(sink);
      const live = requireV2LiveRun(frame.id, sink);
      const lease = admission.acquire(live.agentId, live.conversationId);
      try {
        await withLiveRunLock(live, async () => {
          assertAdmissionCurrent(lease.token);
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
      } finally {
        lease.release();
      }
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
      const lease = admission.acquire(live.agentId, live.conversationId);
      try {
        await cancelLive(live);
      } finally {
        lease.release();
      }
    },

    async cancelV2(frame, sink) {
      assertAccepting();
      const live = requireV2LiveRun(frame.id, sink);
      const lease = admission.acquire(live.agentId, live.conversationId);
      try {
        await cancelLive(live);
      } finally {
        lease.release();
      }
    },

    async enqueueInput(frame, sink) {
      const subscription = requireV2Subscription(sink, frame.conversationId, frame.agentId);
      const lease = admission.acquire(frame.agentId, frame.conversationId);
      try {
        assertAgentAccepting(frame.agentId);
        const key = liveRunKey(subscription.agentId, subscription.conversationId);
        const live = liveRuns.get(key);
        const steerAdmissions: Promise<void>[] = [];
        const mutate = async (): Promise<void> => {
          assertAdmissionCurrent(lease.token);
          assertAgentAccepting(frame.agentId);
          if (live) await catchUpRunJournals(live);
          assertAdmissionCurrent(lease.token);
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
          await publishCommandResult(result, sink, subscription, lease.token);
          if (
            frame.behavior === 'steer' &&
            live &&
            !result.replayed &&
            result.conversation !== undefined
          ) {
            if (canAdmitSteer(live) && admission.isCurrent(lease.token)) {
              steerAdmissions.push(startSteerAdmission(live, frame, lease.token));
            } else {
              live.backendRejectedInputIds.add(frame.inputId);
            }
          }
        };
        if (live) await withLiveRunLock(live, mutate);
        else await mutate();
        await Promise.all(
          steerAdmissions.map((pending) =>
            pending.catch(() => {
              // The command is already durably accepted. Admission/terminalization
              // failure is retained on the LiveRun for terminal recovery and must
              // never be reclassified by the caller as command_rejected.
            }),
          ),
        );
      } finally {
        lease.release();
      }
    },

    async editFollowUp(frame, sink) {
      assertAccepting();
      const subscription = requireV2Subscription(sink, frame.conversationId);
      const lease = admission.acquire(subscription.agentId, frame.conversationId);
      try {
        const live = liveRuns.get(liveRunKey(subscription.agentId, subscription.conversationId));
        const mutate = async (): Promise<void> => {
          assertAdmissionCurrent(lease.token);
          assertAccepting();
          if (live) await catchUpRunJournals(live);
          assertAdmissionCurrent(lease.token);
          assertCurrentV2Subscription(sink, subscription);
          const result = conversations.editFollowUp({
            commandId: frame.id,
            conversationId: frame.conversationId,
            inputId: frame.inputId,
            expectedRevision: frame.expectedRevision,
            text: frame.text,
            images: frame.images,
          });
          await publishCommandResult(result, sink, subscription, lease.token);
        };
        if (live) await withLiveRunLock(live, mutate);
        else await mutate();
      } finally {
        lease.release();
      }
    },

    async removeFollowUp(frame, sink) {
      assertAccepting();
      const subscription = requireV2Subscription(sink, frame.conversationId);
      const lease = admission.acquire(subscription.agentId, frame.conversationId);
      try {
        const live = liveRuns.get(liveRunKey(subscription.agentId, subscription.conversationId));
        const mutate = async (): Promise<void> => {
          assertAdmissionCurrent(lease.token);
          assertAccepting();
          if (live) await catchUpRunJournals(live);
          assertAdmissionCurrent(lease.token);
          assertCurrentV2Subscription(sink, subscription);
          const result = conversations.removeFollowUp({
            commandId: frame.id,
            conversationId: frame.conversationId,
            inputId: frame.inputId,
            expectedRevision: frame.expectedRevision,
          });
          await publishCommandResult(result, sink, subscription, lease.token);
        };
        if (live) await withLiveRunLock(live, mutate);
        else await mutate();
      } finally {
        lease.release();
      }
    },

    async resumeFollowUps(frame, sink) {
      const subscription = requireV2Subscription(sink, frame.conversationId);
      const lease = admission.acquire(subscription.agentId, frame.conversationId);
      try {
        assertAgentAccepting(subscription.agentId);
        const live = liveRuns.get(liveRunKey(subscription.agentId, frame.conversationId));
        const mutate = async (): Promise<void> => {
          assertAdmissionCurrent(lease.token);
          assertAgentAccepting(subscription.agentId);
          if (live) await catchUpRunJournals(live);
          assertAdmissionCurrent(lease.token);
          assertCurrentV2Subscription(sink, subscription);
          const result = conversations.resumeFollowUps({
            commandId: frame.id,
            conversationId: frame.conversationId,
            expectedQueueRevision: frame.expectedQueueRevision,
          });
          await publishCommandResult(result, sink, subscription, lease.token);
        };
        if (live) await withLiveRunLock(live, mutate);
        else await mutate();
      } finally {
        lease.release();
      }
    },

    async resumeRecoveredQueues(conversationIds) {
      assertAccepting();
      await settleAll(
        [...new Set(conversationIds)].map(async (conversationId) => {
          const before = conversations.getV2(conversationId);
          if (
            !before ||
            before.queuePaused ||
            before.status === 'archived' ||
            before.status === 'deleted' ||
            !options.isAgentEnabled(before.agentId)
          ) {
            return;
          }
          const lease = admission.acquire(before.agentId, conversationId);
          try {
            assertAdmissionCurrent(lease.token);
            const current = conversations.getV2(conversationId);
            if (
              !current ||
              current.queuePaused ||
              current.status === 'archived' ||
              current.status === 'deleted' ||
              !options.isAgentEnabled(current.agentId)
            ) {
              return;
            }
            const key = liveRunKey(current.agentId, conversationId);
            if (liveRuns.has(key)) return;
            assertAdmissionCurrent(lease.token);
            const claimed = conversations.claimNextFollowUp(conversationId);
            if (!claimed) return;
            assertAdmissionCurrent(lease.token);
            const live = installLiveRun(claimed.run, lease.token);
            await publishV2Transaction(
              claimed.run.conversation,
              [claimed.transition.frame, claimed.run.v2Frame],
              () => {
                activateLiveRun(live, claimed.run);
              },
            );
          } finally {
            lease.release();
          }
        }),
        'Failed to resume recovered Follow Up queues',
      );
    },

    async suspend(cleanupToken) {
      if (cleanupToken) admission.assertCleanupToken(cleanupToken, 'process');
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
      removeConversationSubscriberEverywhere(v1Sink);
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

    async disableAgent(agentId, cleanupToken) {
      admission.assertCleanupToken(cleanupToken, 'agent', agentId);
      quiescingAgents.add(agentId);
      const paused = conversations.pauseFollowUpsForAgentDisable(agentId);
      for (const transition of paused) {
        await publishV2Transaction(transition.conversation, [transition.frame]);
      }
      const matching = [...liveRuns.values()].filter((live) => live.agentId === agentId);
      for (const live of matching) live.cancelRequested = true;
      await settleAll(
        matching.map((live) => requestTerminal(live, quiescingIntent(live, 'interrupted'))),
      );
    },

    async deleteAgent(agentId, cleanupToken) {
      admission.assertCleanupToken(cleanupToken, 'agent', agentId);
      quiescingAgents.add(agentId);
      const conversationsBefore = [];
      let cursor: string | undefined;
      do {
        const page = conversations.listV2({
          agentId,
          limit: 100,
          ...(cursor === undefined ? {} : { cursor }),
        });
        conversationsBefore.push(...page.items);
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);
      const watermarks = new Map(
        conversationsBefore.map((conversation) => [conversation.id, conversation.v2LastSeq]),
      );
      const matching = [...liveRuns.values()].filter((live) => live.agentId === agentId);
      for (const live of matching) live.cancelRequested = true;
      await settleAll(
        matching.map((live) => requestTerminal(live, quiescingIntent(live, 'interrupted'))),
      );
      const archived = conversations.archiveAgentConversations(agentId);
      for (const summary of archived) {
        const frames = conversations.readV2Since(
          agentId,
          summary.id,
          watermarks.get(summary.id) ?? 0,
        ).frames;
        const current = conversations.getV2(summary.id);
        if (!current) continue;
        await queueOutbound(summary.id, () => {
          try {
            options.onChanged?.(summary);
          } catch {
            // Storage is authoritative.
          }
          for (const frame of frames) broadcastV2Now(frame);
        });
      }
    },

    allowAgent(agentId) {
      quiescingAgents.delete(agentId);
    },

    async stop() {
      stopped = true;
      const active = [...liveRuns.values()].filter((live) => !live.recoveryRequired);
      for (const live of active) live.cancelRequested = true;
      await settleAll(
        active.map((live) => requestTerminal(live, quiescingIntent(live, 'cancelled'))),
      );
      conversationSubscribers.clear();
      observers.clear();
    },
  };

  return hub;
}
