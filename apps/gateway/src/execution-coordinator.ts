import { randomUUID } from 'node:crypto';
import type { AgentEvent, ClientLocation } from '@dash/agent';
import type {
  ConversationKind,
  ConversationMessageOrigin,
  ConversationQueueSnapshot,
  ConversationSummary,
  MobileImage,
} from '@dash/mobile-contract';
import { isTransientAgentEvent } from '@dash/swarm';
import type { AgentChatCoordinator } from './agent-chat-coordinator.js';
import type { ConversationAutoTitleService } from './conversation-auto-title.js';
import {
  type AcceptedTurn,
  type ConversationCommandReceipt,
  type ConversationCommandTarget,
  type ConversationService,
  ConversationServiceError,
  type EditPendingInput,
  type EnqueueFollowUpInput,
  type InterruptAndEnqueueInput,
  type PersistedTurnFrame,
  type RemovePendingInput,
} from './conversation-service.js';
import { type LegacyExecution, createLegacyExecution } from './legacy-execution.js';
import type { MemorySweepService } from './memory-sweep.js';
import type { SkillReviewService } from './skill-review.js';

export interface ExecutionCoordinatorOptions {
  conversations: ConversationService;
  agents: AgentChatCoordinator;
  autoTitle: ConversationAutoTitleService;
  memorySweep?: Pick<MemorySweepService, 'schedule'>;
  skillReview?: Pick<SkillReviewService, 'schedule'>;
  swarmCoordinator?: { cancelTurn(agentId: string, conversationId: string): boolean };
  onChanged?(summary: ConversationSummary): void;
}

export interface ExecutionTurn {
  agentId: string;
  conversationId: string;
  turnId: string;
  origin: ConversationMessageOrigin;
  kind: ConversationKind;
}
export interface StartTurnInput {
  agentId: string;
  conversationId: string;
  turnId: string;
  channelId?: string;
  text: string;
  images?: MobileImage[];
  location?: ClientLocation;
  modality?: 'text' | 'voice';
  origin?: ConversationMessageOrigin;
  requestId?: string;
}
export type ExecutionUpdate =
  | { type: 'accepted'; turn: ExecutionTurn; accepted: AcceptedTurn; requestId?: string }
  | { type: 'persisted'; turn: ExecutionTurn; persisted: PersistedTurnFrame }
  | { type: 'transient'; turn: ExecutionTurn; event: AgentEvent }
  | {
      type: 'command';
      agentId: string;
      conversationId: string;
      receipt: ConversationCommandReceipt;
    }
  | {
      type: 'queue';
      agentId: string;
      conversationId: string;
      queue: ConversationQueueSnapshot;
      commandId?: string;
    }
  | { type: 'settled'; turn: ExecutionTurn };

/** The turn a `TurnObserver` callback is about. */
export interface ObservedTurn {
  agentId: string;
  conversationId: string;
  turnId: string;
}

export type TurnOutcome = 'completed' | 'cancelled' | 'failed';

/**
 * Watches every turn the coordinator runs. The sub-agent coordinator (design
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

export interface ExecutionCoordinator {
  start(input: StartTurnInput): AcceptedTurn;
  startSystemTurn(input: StartSystemTurnInput): { turnId: string };
  followUp(input: EnqueueFollowUpInput): ConversationCommandReceipt;
  interruptAndSend(input: InterruptAndEnqueueInput): ConversationCommandReceipt;
  stopConversation(input: ConversationCommandTarget): ConversationCommandReceipt;
  resumePending(input: ConversationCommandTarget): ConversationCommandReceipt;
  editPending(input: EditPendingInput): ConversationCommandReceipt;
  removePending(input: RemovePendingInput): ConversationCommandReceipt;
  answer(turnId: string, questionId: string, answer: string): Promise<void>;
  cancel(turnId: string): Promise<void>;
  getLiveTurn(turnId: string): ExecutionTurn | undefined;
  assertAccepting(): void;
  subscribe(listener: (update: ExecutionUpdate) => void): () => void;
  addObserver(observer: TurnObserver): () => void;
  cancelAgent(agentId: string): Promise<void>;
  allowAgent(agentId: string): void;
  stop(): Promise<void>;
  readonly legacy: LegacyExecution;
}

function conversationKey(agentId: string, conversationId: string): string {
  return `${agentId}/${conversationId}`;
}

interface LiveTurn {
  turnId: string;
  agentId: string;
  conversationId: string;
  origin: ConversationMessageOrigin;
  /**
   * `'subagent'` for a CHILD conversation's turn. Read only by the post-turn
   * work below, which is the parent's, not the child's.
   */
  kind: ConversationKind;
  controller: AbortController;
  cancelled: boolean;
  terminal: boolean;
  settled: boolean;
  /** One `onFinish` per turn, whichever path gets there first. */
  finishNotified: boolean;
  /** Durable pending item represented by this execution, if queue-admitted. */
  pendingItemId?: string;
  /** Terminal outcome, set before provider cleanup completes. */
  outcome?: TurnOutcome;
  /** Interrupt may advance after cancellation; Stop can fence it back off. */
  advanceAfterSettlement: boolean;
  promise: Promise<void>;
}

export function createExecutionCoordinator(
  options: ExecutionCoordinatorOptions,
): ExecutionCoordinator {
  const { conversations, agents } = options;
  const turns = new Map<string, LiveTurn>();
  const listeners = new Set<(update: ExecutionUpdate) => void>();
  const advancingConversations = new Set<string>();
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
        'Agent is being disabled. Try again shortly.',
        409,
        true,
      );
    }
  };

  // Notification and maintenance hooks observe an execution; they cannot
  // prevent accepted work from starting or rewrite a durable outcome.
  const sideEffect = (name: string, action: () => void): void => {
    try {
      action();
    } catch (error) {
      console.error(`[execution-coordinator] ${name} threw`, error);
    }
  };
  const notifyChanged = (conversation: ConversationSummary): void => {
    sideEffect('conversation change listener', () => options.onChanged?.(conversation));
  };

  const turnIdentity = (live: ExecutionTurn): ExecutionTurn => ({
    agentId: live.agentId,
    conversationId: live.conversationId,
    turnId: live.turnId,
    origin: live.origin,
    kind: live.kind,
  });
  const deliver = (update: ExecutionUpdate): void => {
    for (const listener of [...listeners]) {
      try {
        listener(update);
      } catch (error) {
        console.error('[execution-coordinator] listener threw', error);
      }
    }
  };
  const pendingTurnUpdates: ExecutionUpdate[] = [];
  let publishingTurn = false;
  const publish = (update: ExecutionUpdate): void => {
    // Command responses must stay in their caller's synchronous scope: the
    // transport associates a receipt with that command's submitting sink.
    // They have no journal sequence. Ordered turn updates instead drain as
    // a FIFO so a listener's cancellation cannot publish seq N+1 to a peer
    // before that peer receives the triggering event at seq N.
    if (update.type === 'command' || update.type === 'queue') {
      deliver(update);
      return;
    }
    pendingTurnUpdates.push(update);
    if (publishingTurn) return;
    publishingTurn = true;
    try {
      while (pendingTurnUpdates.length > 0) {
        const pending = pendingTurnUpdates.shift();
        if (pending) deliver(pending);
      }
    } finally {
      publishingTurn = false;
    }
  };
  const publishQueue = (
    agentId: string,
    conversationId: string,
    queue: ConversationQueueSnapshot,
    commandId?: string,
  ): void => {
    publish({ type: 'queue', agentId, conversationId, queue, ...(commandId ? { commandId } : {}) });
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
        console.error('[execution-coordinator] turn observer onEvent threw', error);
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
        console.error('[execution-coordinator] turn observer onFinish threw', error);
      }
    }
  };

  const unsettledTurn = (agentId: string, conversationId: string): LiveTurn | undefined =>
    [...turns.values()].find(
      (live) => live.agentId === agentId && live.conversationId === conversationId && !live.settled,
    );

  let advancePending: (agentId: string, conversationId: string) => void = () => {};

  const finish = (live: LiveTurn, outcome: 'completed' | 'cancelled'): PersistedTurnFrame => {
    const persisted = conversations.finishTurn({
      conversationId: live.conversationId,
      turnId: live.turnId,
      outcome,
    });
    live.terminal = true;
    live.outcome = outcome;
    publish({ type: 'persisted', turn: turnIdentity(live), persisted });
    notifyChanged(persisted.conversation);
    return persisted;
  };

  const runTurn = async (live: LiveTurn, frame: StartTurnInput): Promise<void> => {
    let stream: ReturnType<AgentChatCoordinator['chat']> | undefined;
    let failureMessage: string | undefined;
    try {
      stream = agents.chat({
        agentId: frame.agentId,
        conversationId: frame.conversationId,
        channelId: frame.channelId,
        text: frame.text,
        images: frame.images?.length
          ? frame.images.map((image) => ({ type: 'image' as const, ...image }))
          : undefined,
        location: frame.location,
        modality: frame.modality,
        messageId: frame.turnId,
        signal: live.controller.signal,
      });
      while (true) {
        const result = await stream.next();
        if (result.done) break;
        const event = result.value;
        if (event.type === 'error') throw event.error;
        if (isTransientAgentEvent(event)) {
          // Spec §7.2: live-stream only. Subscribers still see it, but it is
          // never persisted — hence no seq, and no row for a resume to replay.
          publish({ type: 'transient', turn: turnIdentity(live), event });
          notifyEvent(live, event);
          continue;
        }
        const persisted = conversations.appendTurnEvent(live.conversationId, live.turnId, event);
        if (persisted) {
          publish({ type: 'persisted', turn: turnIdentity(live), persisted });
          notifyEvent(live, event);
        }
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
          sideEffect('memory sweep scheduling', () =>
            options.memorySweep?.schedule({
              agentId: live.agentId,
              conversationId: live.conversationId,
              turnId: live.turnId,
            }),
          );
          // Only completed turns are reviewed: a failed or cancelled turn has no
          // outcome to learn from, and half of one is worse than none.
          sideEffect('skill review scheduling', () =>
            options.skillReview?.schedule({
              agentId: live.agentId,
              conversationId: live.conversationId,
              turnId: live.turnId,
            }),
          );
        }
      }
    } catch (error) {
      if (!live.cancelled) {
        const message = error instanceof Error ? error.message : String(error);
        failureMessage = message;
        const persisted = conversations.finishTurn({
          conversationId: live.conversationId,
          turnId: live.turnId,
          outcome: 'failed',
          error: message,
          retryable: false,
        });
        live.terminal = true;
        live.outcome = 'failed';
        publish({ type: 'persisted', turn: turnIdentity(live), persisted });
        notifyChanged(persisted.conversation);
      }
    } finally {
      try {
        if (stream) await stream.return(undefined);
      } finally {
        live.settled = true;
        const shouldAdvance =
          live.outcome === 'completed' ||
          (live.outcome === 'cancelled' && live.advanceAfterSettlement);
        if (live.pendingItemId) {
          conversations.completePendingClaim(live.pendingItemId, !shouldAdvance);
          publishQueue(
            live.agentId,
            live.conversationId,
            conversations.queueSnapshot(live.conversationId),
          );
        } else if (!shouldAdvance) {
          conversations.pausePending(live.conversationId);
          publishQueue(
            live.agentId,
            live.conversationId,
            conversations.queueSnapshot(live.conversationId),
          );
        }
        if (live.terminal && turns.get(live.turnId) === live) turns.delete(live.turnId);
        publish({ type: 'settled', turn: turnIdentity(live) });
        // Notify only after the provider stream and durable queue bookkeeping
        // have settled. Finish observers can start notification turns, and the
        // conversation fence must see the previous run as fully released.
        notifyFinish(live, live.outcome ?? 'failed', failureMessage);
        if (shouldAdvance) advancePending(live.agentId, live.conversationId);
      }
    }
  };

  const cancelLive = (live: LiveTurn, advanceAfterSettlement = false): void => {
    if (!advanceAfterSettlement || !live.cancelled) {
      live.advanceAfterSettlement = advanceAfterSettlement;
    }
    if (live.terminal) return;
    if (live.cancelled) return;
    const recoveringSettledFailure = live.settled;
    finish(live, 'cancelled');
    live.cancelled = true;
    live.controller.abort();
    let hookFailure: { error: unknown } | undefined;
    try {
      agents.cancel(live.agentId, live.conversationId);
    } catch (error) {
      hookFailure = { error };
    }
    try {
      options.swarmCoordinator?.cancelTurn(live.agentId, live.conversationId);
    } catch (error) {
      hookFailure ??= { error };
    }
    // A settled, non-terminal live turn exists only when its earlier terminal
    // persistence failed. Once this retry succeeds, do not let that historical
    // rejection make cancelAgent() or stop() report a false cleanup failure.
    if (recoveringSettledFailure) {
      live.promise = live.promise.catch(() => {});
      notifyFinish(live, 'cancelled');
    }
    if (live.settled && turns.get(live.turnId) === live) {
      turns.delete(live.turnId);
      publish({ type: 'settled', turn: turnIdentity(live) });
    }
    if (hookFailure) throw hookFailure.error;
  };

  const legacy = createLegacyExecution({
    agents,
    swarmCoordinator: options.swarmCoordinator,
    assertAccepting: assertAgentAccepting,
    hasCanonicalTurn: (agentId, conversationId) => {
      if (
        [...turns.values()].some(
          (turn) => turn.agentId === agentId && turn.conversationId === conversationId,
        )
      )
        return true;
      const conversation = conversations.get(conversationId);
      return (
        conversation?.agentId === agentId &&
        (!!conversation.activeTurnId ||
          (conversation.pendingScheduling === 'running' && conversation.pendingCount > 0))
      );
    },
  });

  const assertQueueAdmission = (input: ConversationCommandTarget): void => {
    assertAgentAccepting(input.agentId);
    if (
      legacy.hasActiveTurn(input.agentId, input.conversationId) &&
      !conversations.hasCommand(input.commandId)
    ) {
      throw new ConversationServiceError(
        'conversation_busy',
        'Conversation has an active legacy turn.',
        409,
        true,
      );
    }
  };

  const acceptAndRun = (
    frame: StartTurnInput,
    origin: ConversationMessageOrigin,
    pendingItemId?: string,
  ): AcceptedTurn => {
    assertAgentAccepting(frame.agentId);
    if (legacy.hasActiveTurn(frame.agentId, frame.conversationId)) {
      throw new ConversationServiceError(
        'conversation_busy',
        'The previous turn is still settling',
        409,
        true,
      );
    }
    const unsettled = unsettledTurn(frame.agentId, frame.conversationId);
    if (unsettled && unsettled.turnId !== frame.turnId) {
      throw new ConversationServiceError(
        'conversation_busy',
        'The previous turn is still settling',
        409,
        true,
        { activeTurnId: unsettled.turnId },
      );
    }
    const accepted = conversations.acceptTurn({
      agentId: frame.agentId,
      conversationId: frame.conversationId,
      turnId: frame.turnId,
      text: frame.text,
      images: frame.images,
      origin,
      ...(pendingItemId ? { pendingItemId } : {}),
    });
    if (!accepted.created) return accepted;
    const live: LiveTurn = {
      turnId: frame.turnId,
      agentId: frame.agentId,
      conversationId: frame.conversationId,
      origin,
      kind: accepted.conversation.kind,
      controller: new AbortController(),
      cancelled: false,
      terminal: false,
      settled: false,
      finishNotified: false,
      ...(accepted.pendingItemId ? { pendingItemId: accepted.pendingItemId } : {}),
      advanceAfterSettlement: false,
      promise: Promise.resolve(),
    };
    turns.set(frame.turnId, live);
    publish({
      type: 'accepted',
      turn: turnIdentity(live),
      accepted,
      ...(frame.requestId !== undefined ? { requestId: frame.requestId } : {}),
    });
    if (accepted.firstUserMessage) {
      sideEffect('auto-title scheduling', () =>
        options.autoTitle.schedule({
          conversationId: frame.conversationId,
          agentId: frame.agentId,
          text: frame.text,
        }),
      );
    }
    notifyChanged(accepted.conversation);
    live.promise = runTurn(live, frame);
    void live.promise.catch(() => {});
    return accepted;
  };

  const publishCommand = (
    agentId: string,
    conversationId: string,
    receipt: ConversationCommandReceipt,
  ): void => {
    publish({ type: 'command', agentId, conversationId, receipt });
    publishQueue(agentId, conversationId, receipt.queue, receipt.id);
    const summary = conversations.get(conversationId);
    if (summary) notifyChanged(summary);
  };
  advancePending = (agentId, conversationId) => {
    if (stopped || quiescingAgents.has(agentId)) return;
    if (unsettledTurn(agentId, conversationId) || legacy.hasActiveTurn(agentId, conversationId))
      return;
    const key = conversationKey(agentId, conversationId);
    if (advancingConversations.has(key)) return;
    advancingConversations.add(key);
    try {
      const pending = conversations.claimNextPending(conversationId);
      if (!pending?.claimedTurnId) return;
      publishQueue(agentId, conversationId, conversations.queueSnapshot(conversationId));
      const frame: StartTurnInput = {
        turnId: pending.claimedTurnId,
        requestId: pending.commandId,
        agentId,
        channelId: 'direct',
        conversationId,
        text: pending.text,
        ...(pending.images ? { images: pending.images } : {}),
      };
      try {
        acceptAndRun(frame, 'user', pending.id);
      } catch (error) {
        conversations.releasePendingClaim(pending.id);
        conversations.pausePending(conversationId);
        publishQueue(agentId, conversationId, conversations.queueSnapshot(conversationId));
        throw error;
      }
    } finally {
      advancingConversations.delete(key);
    }
  };

  const cancelAndSettle = async (
    matching: LiveTurn[],
    stopLegacy: () => Promise<void>,
  ): Promise<void> => {
    const results = await Promise.allSettled([
      ...matching.map(async (live) => {
        try {
          cancelLive(live);
        } catch (error) {
          // Failed terminal persistence leaves the run uncancelled and
          // retryable. Once cancellation has taken effect, a throwing abort
          // hook must not release shutdown before provider cleanup settles.
          if (!live.cancelled) throw error;
          await live.promise.catch(() => {});
          throw error;
        }
        await live.promise;
      }),
      stopLegacy(),
    ]);
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  };

  const execution: ExecutionCoordinator = {
    legacy,
    start(input) {
      return acceptAndRun(input, input.origin ?? 'user');
    },
    getLiveTurn(turnId) {
      const live = turns.get(turnId);
      return live ? turnIdentity(live) : undefined;
    },
    assertAccepting,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    startSystemTurn(input) {
      const turnId = input.turnId ?? randomUUID();
      acceptAndRun({ ...input, turnId, channelId: 'system' }, input.origin);
      return { turnId };
    },
    followUp(frame) {
      assertQueueAdmission(frame);
      const receipt = conversations.enqueueFollowUp({
        commandId: frame.commandId,
        agentId: frame.agentId,
        conversationId: frame.conversationId,
        text: frame.text,
        images: frame.images,
      });
      publishCommand(frame.agentId, frame.conversationId, receipt);
      if (receipt.status !== 'rejected') advancePending(frame.agentId, frame.conversationId);
      return receipt;
    },

    interruptAndSend(frame) {
      assertQueueAdmission(frame);
      const receipt = conversations.interruptAndEnqueue({
        commandId: frame.commandId,
        agentId: frame.agentId,
        conversationId: frame.conversationId,
        expectedActiveTurnId: frame.expectedActiveTurnId,
        text: frame.text,
        images: frame.images,
      });
      publishCommand(frame.agentId, frame.conversationId, receipt);
      if (receipt.status === 'rejected') return receipt;
      const live = receipt.affectedTurnId ? turns.get(receipt.affectedTurnId) : undefined;
      if (
        live?.agentId === frame.agentId &&
        live.conversationId === frame.conversationId &&
        !live.settled
      ) {
        cancelLive(live, true);
      } else {
        advancePending(frame.agentId, frame.conversationId);
      }
      return receipt;
    },

    stopConversation(frame) {
      assertAgentAccepting(frame.agentId);
      const receipt = conversations.stopConversation({
        commandId: frame.commandId,
        agentId: frame.agentId,
        conversationId: frame.conversationId,
      });
      publishCommand(frame.agentId, frame.conversationId, receipt);
      if (receipt.status === 'rejected' || !receipt.affectedTurnId) return receipt;
      const live = turns.get(receipt.affectedTurnId);
      if (live?.agentId === frame.agentId && live.conversationId === frame.conversationId) {
        cancelLive(live, false);
      }
      return receipt;
    },

    resumePending(frame) {
      assertQueueAdmission(frame);
      const receipt = conversations.resumePending({
        commandId: frame.commandId,
        agentId: frame.agentId,
        conversationId: frame.conversationId,
      });
      publishCommand(frame.agentId, frame.conversationId, receipt);
      if (receipt.status !== 'rejected') advancePending(frame.agentId, frame.conversationId);
      return receipt;
    },

    editPending(frame) {
      assertAgentAccepting(frame.agentId);
      const receipt = conversations.editPending({
        commandId: frame.commandId,
        agentId: frame.agentId,
        conversationId: frame.conversationId,
        pendingId: frame.pendingId,
        expectedVersion: frame.expectedVersion,
        text: frame.text,
        images: frame.images,
      });
      publishCommand(frame.agentId, frame.conversationId, receipt);
      return receipt;
    },

    removePending(frame) {
      assertAgentAccepting(frame.agentId);
      const receipt = conversations.removePending({
        commandId: frame.commandId,
        agentId: frame.agentId,
        conversationId: frame.conversationId,
        pendingId: frame.pendingId,
        expectedVersion: frame.expectedVersion,
      });
      publishCommand(frame.agentId, frame.conversationId, receipt);
      if (receipt.status !== 'rejected') advancePending(frame.agentId, frame.conversationId);
      return receipt;
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

    async cancel(turnId) {
      assertAccepting();
      const live = turns.get(turnId);
      if (live) cancelLive(live);
    },

    async cancelAgent(agentId) {
      quiescingAgents.add(agentId);
      const matching = [...turns.values()].filter((live) => live.agentId === agentId);
      await cancelAndSettle(matching, () => legacy.cancelAgent(agentId));
    },

    allowAgent(agentId) {
      quiescingAgents.delete(agentId);
    },

    async stop() {
      stopped = true;
      const active = [...turns.values()];
      await cancelAndSettle(active, () => legacy.stop());
      listeners.clear();
      observers.clear();
    },
  };

  return execution;
}
