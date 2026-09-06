import type { AgentEvent } from '@dash/agent';
import { DEFAULT_SUBAGENT_TYPE, legacyWorkerDoneStatus } from './subagent-status.js';
import type {
  ChildSnapshot,
  ChildSpec,
  ChildTurnDriver,
  ChildTurnOutcome,
  WorkerStatus,
} from './types.js';

export interface ChildHandleOptions {
  spec: Omit<ChildSpec, 'extraTools'>;
  /** Runs the child's turns. See {@link ChildTurnDriver}. */
  driver: ChildTurnDriver;
  /**
   * Pushes onto the PARENT's live event channel. Looked up per emission by the
   * coordinator and a no-op when the parent has no live turn — a background
   * child outlives the turn that spawned it, and its progress must not be
   * written into a closed channel.
   */
  emit(event: AgentEvent): void;
  maxSteers: number;
  /**
   * Steers already spent by an EARLIER handle for this same child (a resume
   * builds a new handle over the same conversation). Without it every resume
   * would hand the child a fresh budget and `maxSteersPerWorker` would cap
   * nothing.
   */
  steersUsed?: number;
  /**
   * RESUME: continue an existing child conversation with this message instead
   * of starting from `spec.brief`. The row already exists (`createChild` is
   * idempotent on id), so the only other difference is that the handle puts the
   * row back to `running`.
   */
  resumeWith?: string;
  /**
   * The child's OWN wall clock, in seconds. Per child rather than per run: a
   * background child outlives the turn that spawned it, so a run-scoped clock
   * would either kill it early or, once the run's timer is cleared by finalize,
   * never fire at all. Unset = no deadline.
   */
  maxRunSeconds?: number;
  /** Heartbeat interval while running. Default 10_000ms. */
  heartbeatMs?: number;
  onTerminal(handle: ChildHandle): void;
  /**
   * Fired ONCE on every terminal path, carrying the spec so the spawner can
   * undo what it set up (the gateway removes an `isolation: worktree`
   * checkout). Never awaited and never trusted.
   */
  onFinished?(spec: Omit<ChildSpec, 'extraTools'> & { workerStatus: string }): void | Promise<void>;
  /** How long `cancel()` gives the driver's abort to settle. */
  cancelStopGraceMs?: number;
  hooks?: {
    subagentStart?(w: { workerId: string; role: string }): void;
    subagentStop?(w: { workerId: string; role: string; status: string }): void;
  };
}

const DEFAULT_HEARTBEAT_MS = 10_000;

/**
 * Spec §7.2: progress is emitted immediately on a status TRANSITION and
 * throttled to 1/s per child while it is merely working. Eight parallel
 * children each streaming a frame per tool call would otherwise be the
 * noisiest thing on the parent's socket.
 */
const PROGRESS_THROTTLE_MS = 1_000;

/** Bound on how long a cancel waits for the driver's abort before notifying. */
export const DEFAULT_CHILD_CANCEL_GRACE_MS = 5_000;

/**
 * The marker a `max_turns` report leads with. A capped child is stopped
 * mid-thought, so its report is whatever it had said by then: the marker tells
 * the parent (and the user) that the text below it is INCOMPLETE and that the
 * child is still addressable — `send_message` resumes it with a fresh budget.
 */
const MAX_TURNS_PARTIAL_MARKER = '[partial: maxTurns reached; resumable with send_message]';

/** The report of a child whose conversation was deleted out from under it. */
export const CHILD_DELETED_REASON = 'child conversation was deleted';

type TerminalChildStatus = Exclude<WorkerStatus, 'spawning' | 'running' | 'waiting_input'>;

interface QuestionWaiter {
  resolve(answer: string): void;
  reject(err: unknown): void;
  cleanup(): void;
}

/**
 * One child, as a state machine over its own CONVERSATION. It starts a turn
 * through the {@link ChildTurnDriver} and folds that turn's observed events and
 * its completion back into a status machine — so a child persists, replays, and
 * survives a restart (design §7.1).
 *
 * Two synchronous-discipline invariants hold, and are the reason the terminal
 * transition is one function:
 *
 *  1. The terminal transition (run when a turn completes) reads the steer queue
 *     and applies its effect in ONE synchronous block. `send()` likewise checks
 *     status and enqueues synchronously, closing the TOCTOU where a steer could
 *     return `{ok:true}` and then be dropped by a concurrent finalize.
 *  2. `cancel()` is synchronous and never awaits the driver. Aborting a pi turn
 *     is cooperative, so awaiting settlement during a cancel could hang.
 */
export class ChildHandle {
  /** The child's conversation id — its subagent id, and its legacy worker id. */
  readonly subagentId: string;
  readonly workerId: string;
  readonly parentConversationId: string;
  readonly parentTurnId: string;
  readonly role: string;
  readonly brief: string;
  readonly model: string;
  readonly subagentType: string;
  readonly description: string;
  readonly name?: string;
  readonly background: boolean;
  readonly oneShot: boolean;
  readonly depth: number;
  readonly resumed: boolean;
  private readonly isolation?: 'worktree';
  private readonly maxTurns?: number;
  /**
   * Where the child runs, when the SPEC already settles it. An
   * `isolation: 'worktree'` child starts undefined and is answered by
   * `driver.workspaceOf` once the runtime has minted the checkout: naming the
   * parent workspace in the meantime would state exactly what isolation exists
   * to deny.
   */
  private readonly specWorkspace?: string;

  status: WorkerStatus = 'spawning';
  report?: string;
  usage: { inputTokens: number; outputTokens: number } = { inputTokens: 0, outputTokens: 0 };
  steersUsed = 0;
  pendingQuestion?: string;
  toolCallCount = 0;

  private readonly opts: ChildHandleOptions;
  private readonly driver: ChildTurnDriver;
  private readonly runId: string;
  private readonly heartbeatMs: number;

  private readonly steerQueue: string[] = [];
  private questionWaiter?: QuestionWaiter;
  private finalized = false;
  private started = false;
  /** The child turn currently in flight, if any. */
  private currentTurnId?: string;

  private startedAt?: number;
  private endedAt?: number;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private wallClockTimer?: ReturnType<typeof setTimeout>;
  private lastEventSummary = '';
  private lastProgressAt = 0;
  private disposers: Array<() => void> = [];

  private readonly terminal: { promise: Promise<void>; resolve: () => void };

  constructor(opts: ChildHandleOptions) {
    this.opts = opts;
    this.driver = opts.driver;
    this.subagentId = opts.spec.childConversationId;
    this.workerId = opts.spec.childConversationId;
    this.parentConversationId = opts.spec.parentConversationId;
    this.parentTurnId = opts.spec.parentTurnId;
    this.role = opts.spec.role;
    this.brief = opts.spec.brief;
    this.model = opts.spec.model;
    this.subagentType = opts.spec.subagentType ?? DEFAULT_SUBAGENT_TYPE;
    this.description = opts.spec.description ?? opts.spec.role;
    this.name = opts.spec.name;
    this.background = opts.spec.background ?? false;
    this.oneShot = opts.spec.oneShot ?? false;
    this.depth = opts.spec.depth ?? 1;
    this.resumed = opts.resumeWith !== undefined;
    this.isolation = opts.spec.isolation;
    this.maxTurns = opts.spec.maxTurns;
    this.specWorkspace = opts.spec.isolation === 'worktree' ? undefined : opts.spec.workspace;
    this.runId = opts.spec.runId;
    this.heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.steersUsed = opts.steersUsed ?? 0;

    let resolveTerminal!: () => void;
    const promise = new Promise<void>((resolve) => {
      resolveTerminal = resolve;
    });
    this.terminal = { promise, resolve: resolveTerminal };
  }

  get terminalPromise(): Promise<void> {
    return this.terminal.promise;
  }

  /** ISO timestamp when the child started, or undefined if not yet started. */
  get startedAtIso(): string | undefined {
    return this.startedAt ? new Date(this.startedAt).toISOString() : undefined;
  }

  /** ISO timestamp when the child ended, or undefined if not yet ended. */
  get endedAtIso(): string | undefined {
    return this.endedAt ? new Date(this.endedAt).toISOString() : undefined;
  }

  /** The child's conversation id. Alias kept for call sites that read a run. */
  get conversationId(): string {
    return this.subagentId;
  }

  /**
   * Creates the child's conversation row and starts its first turn. Everything
   * up to (and including) `startTurn` is synchronous, so a same-batch `wait` or
   * roster read always sees the child.
   */
  start(): void {
    if (this.started || this.finalized) return;
    this.started = true;
    this.status = 'running';
    this.startedAt = Date.now();
    this.opts.hooks?.subagentStart?.({ workerId: this.workerId, role: this.role });

    // Subscribe BEFORE the first turn: the driver may deliver events (or a
    // failure) synchronously from inside `startTurn`.
    // Filtered on the TURN, not just the conversation. A child's conversation
    // is addressable, so a client can open a turn on it that this handle did
    // not start; folding that turn's events into the child's report — or
    // letting its completion terminalize the child — would be wrong twice.
    this.disposers.push(
      this.driver.onEvent((turn, event) => {
        if (!this.ownsTurn(turn)) return;
        if (this.finalized) return;
        this.processEvent(event);
      }),
      this.driver.onFinish((turn, outcome, error) => {
        if (!this.ownsTurn(turn)) return;
        this.onTurnFinished(outcome, error);
      }),
    );

    try {
      this.driver.createChild({
        id: this.subagentId,
        agentId: this.opts.spec.agentId,
        agentName: this.opts.spec.agentName,
        parentConversationId: this.parentConversationId,
        parentTurnId: this.parentTurnId,
        title: this.description,
        subagent: {
          type: this.subagentType,
          ...(this.name !== undefined ? { name: this.name } : {}),
          status: 'running',
          description: this.description,
          prompt: this.brief,
          model: this.model,
          background: this.background,
          ...(this.isolation !== undefined ? { isolation: this.isolation } : {}),
          depth: this.depth,
          startedAt: this.startedAtIsoPrivate(),
          toolCallCount: 0,
          oneShot: this.oneShot,
          ...(this.specWorkspace !== undefined ? { workspace: this.specWorkspace } : {}),
        },
      });
    } catch (err) {
      this.emitStarted();
      this.finalizeFailed(err instanceof Error ? err.message : String(err));
      return;
    }

    // A RESUME re-creates a row that already exists, so `createChild` left the
    // terminal status it was written with; the child is running again now.
    if (this.opts.resumeWith !== undefined) this.persist({ status: 'running' });

    this.emitStarted();
    this.startHeartbeat();
    this.startWallClock();
    this.beginTurn(this.opts.resumeWith ?? this.brief);
  }

  /**
   * Answer a pending question or enqueue a steer. Synchronous check + effect:
   * a caller can never observe `{ok:true}` for a steer a concurrent finalize
   * then drops.
   */
  send(message: string): { ok: boolean; reason?: string } {
    if (this.pendingQuestion !== undefined && this.questionWaiter) {
      this.answerQuestion(message);
      return { ok: true };
    }
    if (this.finalized) return { ok: false, reason: 'worker terminal' };
    if (this.steersUsed >= this.opts.maxSteers) {
      return { ok: false, reason: 'steer cap reached' };
    }
    this.steersUsed++;
    this.steerQueue.push(message);
    return { ok: true };
  }

  answerQuestion(answer: string): boolean {
    const waiter = this.questionWaiter;
    if (!waiter) return false;
    this.clearQuestion();
    if (this.status === 'waiting_input') {
      this.status = 'running';
      this.emitStatus('running');
      this.persist({ status: 'running' });
    }
    waiter.resolve(answer);
    return true;
  }

  /**
   * Park the child in `waiting_input` until the parent answers (the
   * `ask_orchestrator` tool). Rejects on timeout, on abort, and on every
   * terminal transition, so the child's tool call never outlives the child.
   */
  waitForQuestion(
    question: string,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<string> {
    if (this.finalized) return Promise.reject(new Error('worker terminal'));
    if (this.questionWaiter) {
      const prior = this.questionWaiter;
      this.clearQuestion();
      prior.reject(new Error('superseded by a new question'));
    }

    this.pendingQuestion = question;
    this.status = 'waiting_input';
    this.emitStatus('waiting_input', undefined, question);
    this.persist({ status: 'waiting_input' });

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.clearQuestion();
        this.restoreRunningAfterQuestion();
        reject(new Error(`ask_orchestrator timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      if (typeof timer === 'object' && 'unref' in timer) timer.unref();

      const onAbort = () => {
        this.clearQuestion();
        this.restoreRunningAfterQuestion();
        reject(new Error('ask_orchestrator aborted'));
      };
      if (signal) {
        if (signal.aborted) {
          clearTimeout(timer);
          this.clearQuestion();
          this.restoreRunningAfterQuestion();
          reject(new Error('ask_orchestrator aborted'));
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }

      this.questionWaiter = {
        resolve,
        reject,
        cleanup: () => {
          clearTimeout(timer);
          if (signal) signal.removeEventListener('abort', onAbort);
        },
      };
    });
  }

  /**
   * Synchronous, idempotent cancel. NEVER awaits the driver: the child's turn
   * is aborted cooperatively and the spawner notification is chained off that
   * abort (bounded by the grace period) so cleanup never samples a directory
   * the child is still writing to.
   */
  cancel(reason: string): void {
    if (this.finalized) return;
    this.finalized = true;
    this.status = 'cancelled';
    this.report = reason;
    this.endedAt = Date.now();
    this.stopHeartbeat();
    const stopped = this.currentTurnId
      ? this.driver.cancelTurn(this.opts.spec.agentId, this.subagentId).catch(() => {})
      : undefined;
    this.finalizeTerminal('cancelled', reason, stopped);
  }

  snapshot(): ChildSnapshot {
    return {
      subagentId: this.subagentId,
      workerId: this.workerId,
      parentConversationId: this.parentConversationId,
      parentTurnId: this.parentTurnId,
      role: this.role,
      status: this.status,
      brief: this.brief,
      model: this.model,
      report: this.report,
      question: this.pendingQuestion,
      usage: { ...this.usage },
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      subagentType: this.subagentType,
      description: this.description,
      name: this.name,
      toolCallCount: this.toolCallCount,
      background: this.background,
      oneShot: this.oneShot,
      depth: this.depth,
      workspace: this.driver.workspaceOf?.(this.subagentId) ?? this.specWorkspace,
    };
  }

  // --- internals ---

  /** Is this the turn THIS handle started on its own conversation? */
  private ownsTurn(turn: { conversationId: string; turnId: string }): boolean {
    return turn.conversationId === this.subagentId && turn.turnId === this.currentTurnId;
  }

  private beginTurn(text: string): void {
    try {
      const { turnId } = this.driver.startTurn({
        agentId: this.opts.spec.agentId,
        conversationId: this.subagentId,
        text,
        origin: 'parent',
      });
      this.currentTurnId = turnId;
    } catch (err) {
      // Every start failure — a busy conversation, a stopped hub, a deleted
      // row — terminalizes the child. The reason travels in the message so the
      // parent's report says which one it was rather than "failed".
      this.currentTurnId = undefined;
      this.finalizeFailed(err instanceof Error ? err.message : String(err));
    }
  }

  /** The turn observer's completion callback: the atomic terminal transition. */
  private onTurnFinished(outcome: ChildTurnOutcome, error?: string): void {
    if (this.finalized) return;
    this.currentTurnId = undefined;
    if (outcome === 'failed') {
      this.finalizeFailed(error ?? 'the sub-agent turn failed');
      return;
    }
    if (outcome === 'cancelled') {
      // The turn was cancelled by something other than this handle (a hub
      // shutdown, an operator stop on the child conversation).
      this.cancel('the sub-agent turn was cancelled');
      return;
    }
    // --- Atomic terminal transition (no awaits in this block) ---
    if (this.steerQueue.length > 0) {
      const next = this.steerQueue.shift() as string;
      this.beginTurn(next);
      return;
    }
    if (this.status === 'waiting_input') return;
    this.finalizeDone();
  }

  private processEvent(event: AgentEvent): void {
    this.lastEventSummary = summarize(event);
    if (event.type === 'tool_use_start') {
      this.toolCallCount++;
      // Best-effort and lands AFTER the offending call: pi's abort is
      // cooperative, so the call that tripped the cap still completes.
      if (this.maxTurns !== undefined && this.maxTurns > 0 && this.toolCallCount > this.maxTurns) {
        this.finalizeMaxTurns();
        return;
      }
      this.emitThrottledProgress();
    }
    if (event.type === 'response') {
      this.usage.inputTokens += event.usage.inputTokens;
      this.usage.outputTokens += event.usage.outputTokens;
      this.report = event.content;
    } else if (event.type === 'error') {
      this.finalizeFailed(event.error.message);
    }
  }

  private finalizeDone(): void {
    if (this.finalized) return;
    this.finalized = true;
    this.status = 'done';
    this.endedAt = Date.now();
    this.stopHeartbeat();
    this.finalizeTerminal('done', this.report ?? '');
  }

  private finalizeFailed(message: string): void {
    if (this.finalized) return;
    this.finalized = true;
    this.status = 'failed';
    this.report = message;
    this.endedAt = Date.now();
    this.stopHeartbeat();
    this.finalizeTerminal('failed', message);
  }

  /** Terminal transition for a child that ran out of turn budget. */
  private finalizeMaxTurns(): void {
    if (this.finalized) return;
    this.finalized = true;
    this.status = 'max_turns';
    this.report = `${MAX_TURNS_PARTIAL_MARKER}\n\n${this.report ?? ''}`;
    this.endedAt = Date.now();
    this.stopHeartbeat();
    const stopped = this.currentTurnId
      ? this.driver.cancelTurn(this.opts.spec.agentId, this.subagentId).catch(() => {})
      : undefined;
    this.finalizeTerminal('max_turns', this.report, stopped);
  }

  /**
   * The ONE terminal transition, shared by every finalizer. Emits the legacy
   * `worker_done` and its `subagent_finished` twin, persists the terminal row,
   * runs the `subagentStop` hook, notifies the spawner, drops the driver
   * subscriptions, calls `onTerminal` and resolves the terminal promise — in
   * that order, exactly once.
   */
  private finalizeTerminal(
    status: TerminalChildStatus,
    report: string,
    settled?: Promise<void>,
  ): void {
    this.stopWallClock();
    const waiter = this.questionWaiter;
    if (waiter) {
      this.clearQuestion();
      const msg =
        status === 'max_turns'
          ? 'maxTurns limit reached'
          : status === 'cancelled'
            ? 'worker cancelled'
            : `worker ${status}`;
      waiter.reject(new Error(msg));
    }

    this.persist({
      status,
      info: {
        endedAt: new Date(this.endedAt ?? Date.now()).toISOString(),
        report,
        usage: { ...this.usage },
        toolCallCount: this.toolCallCount,
        ...(this.driver.workspaceOf?.(this.subagentId) !== undefined
          ? { workspace: this.driver.workspaceOf(this.subagentId) }
          : {}),
      },
    });

    this.emit({
      type: 'worker_done',
      workerId: this.workerId,
      runId: this.runId,
      role: this.role,
      status: legacyWorkerDoneStatus(status),
      report,
      usage: this.usage,
    });
    this.emitFinished(status, report);
    this.opts.hooks?.subagentStop?.({ workerId: this.workerId, role: this.role, status });
    if (settled) this.notifyFinishedAfter(settled);
    else this.notifyFinished();
    for (const dispose of this.disposers.splice(0)) {
      try {
        dispose();
      } catch {
        // A driver whose disposer throws must not break the terminal transition.
      }
    }
    this.opts.onTerminal(this);
    this.terminal.resolve();
  }

  private notifyFinishedAfter(settled: Promise<void>): void {
    const graceMs = this.opts.cancelStopGraceMs ?? DEFAULT_CHILD_CANCEL_GRACE_MS;
    const grace = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, graceMs);
      if (typeof timer === 'object' && 'unref' in timer) timer.unref();
    });
    void Promise.race([settled, grace]).then(
      () => this.notifyFinished(),
      () => this.notifyFinished(),
    );
  }

  private notifyFinished(): void {
    const hook = this.opts.onFinished;
    if (!hook) return;
    try {
      void Promise.resolve(hook({ ...this.opts.spec, workerStatus: this.status })).catch(() => {});
    } catch {
      // The spawner's problem, not the child's.
    }
  }

  /**
   * Persist a status / info patch onto the child's conversation row. NEVER
   * throws: a cascading parent delete removes the row mid-turn, and a child
   * failing to write its own tombstone must not break its terminal transition.
   */
  private persist(patch: { status?: WorkerStatus; info?: Record<string, unknown> }): void {
    try {
      this.driver.updateChild(this.subagentId, patch);
    } catch {
      // Degrade quietly; the heartbeat's liveness check takes the child down.
    }
  }

  private clearQuestion(): void {
    this.questionWaiter?.cleanup();
    this.questionWaiter = undefined;
    this.pendingQuestion = undefined;
  }

  private restoreRunningAfterQuestion(): void {
    if (this.finalized) return;
    if (this.status === 'waiting_input') {
      this.status = 'running';
      this.emitStatus('running');
      this.persist({ status: 'running' });
    }
  }

  /**
   * The child's own deadline. Fires a cancel like any other, so the terminal
   * transition (report, events, worktree cleanup) is the shared one.
   */
  private startWallClock(): void {
    const seconds = this.opts.maxRunSeconds;
    if (seconds === undefined || seconds <= 0 || this.wallClockTimer) return;
    const timer = setTimeout(() => {
      this.cancel(`the sub-agent exceeded its ${seconds}s wall clock`);
    }, seconds * 1000);
    if (typeof timer === 'object' && 'unref' in timer) timer.unref();
    this.wallClockTimer = timer;
  }

  private stopWallClock(): void {
    if (this.wallClockTimer) {
      clearTimeout(this.wallClockTimer);
      this.wallClockTimer = undefined;
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    const timer = setInterval(() => {
      // Liveness FIRST, and regardless of status: `delete()` cascades to
      // descendants, so a live child's conversation can vanish mid-turn.
      // `appendTurnEvent` then returns null and the turn degrades quietly —
      // which means nothing else will ever stop this child.
      if (!this.driver.isChildAlive(this.subagentId)) {
        this.cancel(CHILD_DELETED_REASON);
        return;
      }
      if (this.status !== 'running') return;
      const elapsedS = this.startedAt ? Math.round((Date.now() - this.startedAt) / 1000) : 0;
      const detail = this.lastEventSummary
        ? `elapsed ${elapsedS}s · ${this.lastEventSummary}`
        : `elapsed ${elapsedS}s`;
      this.emitStatus('running', detail);
    }, this.heartbeatMs);
    if (typeof timer === 'object' && 'unref' in timer) timer.unref();
    this.heartbeatTimer = timer;
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  /** A working child's progress ping, at most one per {@link PROGRESS_THROTTLE_MS}. */
  private emitThrottledProgress(): void {
    const now = Date.now();
    if (now - this.lastProgressAt < PROGRESS_THROTTLE_MS) return;
    this.emitStatus('running', this.lastEventSummary || undefined);
  }

  private emitStatus(
    status: 'running' | 'waiting_input',
    detail?: string,
    question?: string,
  ): void {
    this.lastProgressAt = Date.now();
    this.emit({
      type: 'worker_status',
      workerId: this.workerId,
      runId: this.runId,
      role: this.role,
      status,
      ...(detail !== undefined ? { detail } : {}),
      ...(question !== undefined ? { question } : {}),
    });
    this.emit({
      type: 'subagent_progress',
      subagentId: this.subagentId,
      status,
      toolCallCount: this.toolCallCount,
      elapsedMs: Date.now() - (this.startedAt ?? Date.now()),
      ...(detail !== undefined ? { detail } : {}),
      ...(question !== undefined ? { question } : {}),
    });
  }

  private emitStarted(): void {
    this.emit({
      type: 'subagent_started',
      subagentId: this.subagentId,
      ...(this.name !== undefined ? { name: this.name } : {}),
      subagentType: this.subagentType,
      description: this.description,
      prompt: this.brief,
      model: this.model,
      background: this.background,
      depth: this.depth,
      startedAt: this.startedAtIsoPrivate(),
      ...(this.isolation !== undefined ? { isolation: this.isolation } : {}),
    });
  }

  private startedAtIsoPrivate(): string {
    return new Date(this.startedAt ?? Date.now()).toISOString();
  }

  private emitFinished(status: TerminalChildStatus, report: string): void {
    this.emit({
      type: 'subagent_finished',
      subagentId: this.subagentId,
      ...(this.name !== undefined ? { name: this.name } : {}),
      subagentType: this.subagentType,
      description: this.description,
      status,
      report,
      usage: this.usage,
      toolCallCount: this.toolCallCount,
      startedAt: this.startedAtIsoPrivate(),
      endedAt: new Date(this.endedAt ?? Date.now()).toISOString(),
    });
  }

  private emit(event: AgentEvent): void {
    this.opts.emit(event);
  }
}

function summarize(event: AgentEvent): string {
  switch (event.type) {
    case 'text_delta':
      return 'text';
    case 'thinking_delta':
      return 'thinking';
    case 'tool_use_start':
      return `tool ${event.name}`;
    case 'tool_result':
      return `tool result ${event.name}`;
    case 'response':
      return 'response';
    case 'error':
      return 'error';
    default:
      return event.type;
  }
}
