import type { AgentEvent } from '@dash/agent';
import type { WorkerBackend, WorkerSpec, WorkerStatus } from './types.js';

export interface WorkerHandleOptions {
  spec: Omit<WorkerSpec, 'extraTools'>;
  /** Registration is sync; backend construction is async. */
  backendPromise: Promise<WorkerBackend>;
  /** Pushes into the run's channel; the handle owns its own status transitions. */
  emit(event: AgentEvent): void;
  maxSteers: number;
  /** Heartbeat interval while running. Default 10_000ms. */
  heartbeatMs?: number;
  onTerminal(handle: WorkerHandle): void;
  /**
   * Fired ONCE, on every terminal path (done, failed, cancelled — and any
   * future terminal status, which must route through one of the finalizers).
   * Carries the spec so the spawner can undo whatever it set up for this child:
   * the gateway removes an `isolation: worktree` checkout here, and a hook that
   * only ran on the happy path would leak one directory per cancelled child.
   *
   * Never awaited by the terminal transition (which stays synchronous) and
   * never trusted: a rejection or a synchronous throw is swallowed rather than
   * allowed to break it. On the CANCEL path the call is deferred until the
   * backend's `stop()` settles or `cancelStopGraceMs` expires, so the spawner
   * never inspects a directory the child is still writing to.
   */
  onFinished?(
    spec: Omit<WorkerSpec, 'extraTools'> & { workerStatus: string },
  ): void | Promise<void>;
  /**
   * How long `cancel()` gives the backend's cooperative `stop()` to settle
   * before running `onFinished` anyway. Default `DEFAULT_CANCEL_STOP_GRACE_MS`.
   */
  cancelStopGraceMs?: number;
  hooks?: {
    subagentStart?(w: { workerId: string; role: string }): void;
    subagentStop?(w: { workerId: string; role: string; status: string }): void;
  };
}

const DEFAULT_HEARTBEAT_MS = 10_000;

/**
 * The bound on how long a cancel waits for `stop()` before notifying the
 * spawner anyway. Long enough for a cooperative abort to unwind and flush,
 * short enough that a hung backend delays a cleanup rather than cancelling it:
 * an unconditional await would leak the child's worktree forever.
 */
export const DEFAULT_CANCEL_STOP_GRACE_MS = 5_000;

/** The default subagent type when a caller names none. */
export const DEFAULT_SUBAGENT_TYPE = 'general-purpose';

/**
 * The marker a `max_turns` report leads with. A capped child is stopped
 * mid-thought, so its report is whatever it had said by then: the marker tells
 * the orchestrator (and the user) that the text below it is INCOMPLETE and that
 * the child is still addressable — `send_message` resumes it with a fresh
 * budget rather than the work being lost.
 */
const MAX_TURNS_PARTIAL_MARKER = '[partial: maxTurns reached; resumable with send_message]';

/**
 * The legacy `worker_done` event is a MIRROR of `subagent_finished` kept for the
 * iOS app and Mission Control, whose decoders only understand
 * `done | failed | cancelled`. Until those clients migrate, the newer terminal
 * statuses (`interrupted`, `max_turns`) are reported to them as `failed`; the
 * true status rides `subagent_finished.status`.
 */
export function legacyWorkerDoneStatus(status: WorkerStatus): 'done' | 'failed' | 'cancelled' {
  if (status === 'done' || status === 'cancelled') return status;
  return 'failed';
}

/** The statuses `subagent_finished` can carry. */
type TerminalWorkerStatus = Exclude<WorkerStatus, 'spawning' | 'running' | 'waiting_input'>;

/** Stored resolve/reject pair for an in-flight ask_orchestrator question. */
interface QuestionWaiter {
  resolve(answer: string): void;
  reject(err: unknown): void;
  /** Clears timer + signal listener; safe to call multiple times. */
  cleanup(): void;
}

/**
 * Per-worker state machine driving a `WorkerBackend` conversation across one or
 * more segments (the initial brief plus any steers). The correctness of this
 * class rests on two synchronous-discipline invariants:
 *
 *  1. The terminal transition (run after a segment's generator completes) reads
 *     the steer queue / status and applies its effect in ONE synchronous block —
 *     no awaits between the check and the effect. `send()` likewise checks status
 *     and enqueues/answers synchronously. Together this closes the TOCTOU where a
 *     steer could return {ok:true} yet be dropped by a concurrent finalize.
 *
 *  2. `cancel()` is synchronous and never awaits the backend. pi's abort is
 *     cooperative-only, so awaiting a run to settle during cancel could hang.
 */
export class WorkerHandle {
  readonly workerId: string;
  readonly role: string;
  readonly brief: string;
  readonly model: string;
  /** Resolved subagent type ('general-purpose' when the caller named none). */
  readonly subagentType: string;
  /** 3-5 word UI label; falls back to the role. */
  readonly description: string;
  /** Addressable name, when the caller gave one. */
  readonly name?: string;
  readonly background: boolean;
  readonly oneShot: boolean;
  /** 1 for a direct child of the orchestrator. */
  readonly depth: number;
  private readonly isolation?: 'worktree';
  /**
   * Cap on the child's OWN tool calls, when its definition set one. Enforced
   * here because the pi backend has no `maxSteps`/`maxTurns` of any kind: the
   * handle counts `tool_use_start` and aborts. Undefined = uncapped.
   */
  private readonly maxTurns?: number;
  /**
   * Where the child actually ran.
   *
   * For an ordinary child this is the spec's workspace from the start. For a
   * child that asked for `isolation: 'worktree'` it starts UNDEFINED and is
   * filled in from the backend, which is the only thing that knows the worktree
   * path: reporting the parent workspace in the meantime would state exactly
   * what isolation exists to deny, and a child whose isolation FAILED would
   * state it permanently. Undefined shows the user nothing rather than
   * something false.
   */
  private workspace?: string;

  status: WorkerStatus = 'spawning';
  report?: string;
  usage: { inputTokens: number; outputTokens: number } = { inputTokens: 0, outputTokens: 0 };
  steersUsed = 0;
  pendingQuestion?: string;
  /** Tool calls this worker has started across all of its segments. */
  toolCallCount = 0;

  private readonly opts: WorkerHandleOptions;
  private readonly runId: string;
  private readonly heartbeatMs: number;

  /** Pending steers to run as subsequent segments (FIFO). */
  private readonly steerQueue: string[] = [];
  /** The in-flight question waiter, if any. */
  private questionWaiter?: QuestionWaiter;
  /** Resolved backend, once construction completes. Undefined while pending. */
  private backend?: WorkerBackend;
  /** True once cancel()/terminal has fired — makes cancel idempotent and gates start. */
  private finalized = false;
  private started = false;

  private startedAt?: number;
  private endedAt?: number;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private lastEventSummary = '';

  private readonly terminal: {
    promise: Promise<void>;
    resolve: () => void;
  };

  constructor(opts: WorkerHandleOptions) {
    this.opts = opts;
    this.workerId = opts.spec.workerId;
    this.role = opts.spec.role;
    this.brief = opts.spec.brief;
    this.model = opts.spec.model;
    this.subagentType = opts.spec.subagentType ?? DEFAULT_SUBAGENT_TYPE;
    this.description = opts.spec.description ?? opts.spec.role;
    this.name = opts.spec.name;
    this.background = opts.spec.background ?? false;
    this.oneShot = opts.spec.oneShot ?? false;
    this.depth = opts.spec.depth ?? 1;
    this.isolation = opts.spec.isolation;
    this.maxTurns = opts.spec.maxTurns;
    this.workspace = opts.spec.isolation === 'worktree' ? undefined : opts.spec.workspace;
    // Resolved here rather than in runSegment: a background child can be
    // snapshotted before its first segment runs, and a cancel during
    // construction never reaches runSegment at all. The rejection handler is
    // not optional — the same promise is awaited (and reported) by runSegment,
    // and an unhandled rejection here would be a second, noisier consumer.
    void opts.backendPromise.then(
      (backend) => {
        if (backend.workspace) this.workspace = backend.workspace;
      },
      () => {},
    );
    this.runId = opts.spec.runId;
    this.heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;

    let resolveTerminal!: () => void;
    const promise = new Promise<void>((resolve) => {
      resolveTerminal = resolve;
    });
    this.terminal = { promise, resolve: resolveTerminal };
  }

  get terminalPromise(): Promise<void> {
    return this.terminal.promise;
  }

  /** Begins the first segment with the brief. Idempotent-ish: no-op if already started or cancelled. */
  start(): void {
    if (this.started || this.finalized) return;
    this.started = true;
    this.status = 'running';
    this.startedAt = Date.now();
    this.opts.hooks?.subagentStart?.({ workerId: this.workerId, role: this.role });
    this.emit({
      type: 'subagent_started',
      subagentId: this.workerId,
      ...(this.name !== undefined ? { name: this.name } : {}),
      subagentType: this.subagentType,
      description: this.description,
      prompt: this.brief,
      model: this.model,
      background: this.background,
      depth: this.depth,
      startedAt: this.startedAtIso(),
      ...(this.isolation !== undefined ? { isolation: this.isolation } : {}),
    });
    this.startHeartbeat();
    void this.runSegment(this.brief);
  }

  /**
   * Answer a pending question or enqueue a steer. Synchronous check + effect —
   * there is NO await between the status check and the enqueue, so a caller can
   * never observe {ok:true} for a steer that a concurrent finalize then drops.
   */
  send(message: string): { ok: boolean; reason?: string } {
    if (this.pendingQuestion !== undefined && this.questionWaiter) {
      this.answerQuestion(message);
      return { ok: true };
    }
    if (this.isTerminal()) {
      return { ok: false, reason: 'worker terminal' };
    }
    if (this.steersUsed >= this.opts.maxSteers) {
      return { ok: false, reason: 'steer cap reached' };
    }
    this.steersUsed++;
    this.steerQueue.push(message);
    return { ok: true };
  }

  /** Resolves the in-flight ask_orchestrator waiter. Returns false if none is pending. */
  answerQuestion(answer: string): boolean {
    const waiter = this.questionWaiter;
    if (!waiter) return false;
    this.clearQuestion();
    // Back to running now that the question is answered.
    if (this.status === 'waiting_input') {
      this.status = 'running';
      this.emitStatus('running');
    }
    waiter.resolve(answer);
    return true;
  }

  /**
   * Used by the ask_orchestrator tool. Emits worker_status{waiting_input} and
   * returns a promise settling on answerQuestion (resolve), timeout (reject),
   * the AbortSignal (reject), or cancel() (reject).
   */
  waitForQuestion(
    question: string,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<string> {
    if (this.isTerminal()) {
      return Promise.reject(new Error('worker terminal'));
    }
    // Only one outstanding question at a time; reject any prior waiter.
    if (this.questionWaiter) {
      const prior = this.questionWaiter;
      this.clearQuestion();
      prior.reject(new Error('superseded by a new question'));
    }

    this.pendingQuestion = question;
    this.status = 'waiting_input';
    this.emitStatus('waiting_input', undefined, question);

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.clearQuestion();
        // The question timed out but the worker is NOT terminal — restore
        // 'running' so its segment can finalize with an intact report rather
        // than being stranded in 'waiting_input'.
        this.restoreRunningAfterQuestion();
        reject(new Error(`ask_orchestrator timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      if (typeof timer === 'object' && 'unref' in timer) timer.unref();

      const onAbort = () => {
        this.clearQuestion();
        // Abort of the ask (not a cancel of the worker) — restore 'running' so
        // the worker is not stranded in 'waiting_input'.
        this.restoreRunningAfterQuestion();
        reject(new Error('ask_orchestrator aborted'));
      };
      if (signal) {
        if (signal.aborted) {
          clearTimeout(timer);
          // Pre-aborted: no questionWaiter is stored yet, so clear the pending
          // question ourselves and restore 'running' before rejecting.
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
   * Synchronous, idempotent cancel. NEVER awaits the backend: rejects the pending
   * question waiter, aborts the backend if constructed, emits worker_done{cancelled},
   * fires onTerminal, and leaves stop() running in the background.
   *
   * The ONE thing that waits for stop() is the spawner notification. pi's abort
   * is cooperative, so when cancel() returns the child may still be inside a
   * tool call; a spawner told to clean up at that moment would sample the
   * child's worktree mid-write, read it clean and delete the directory out from
   * under a live process. So `onFinished` is chained off `stop()` — bounded by
   * `cancelStopGraceMs`, because a `stop()` that never settles must DELAY the
   * cleanup, not cancel it, or the worktree leaks for the gateway's lifetime.
   */
  cancel(reason: string): void {
    if (this.finalized) return;
    this.finalized = true;
    this.status = 'cancelled';
    this.report = reason;
    this.endedAt = Date.now();
    this.stopHeartbeat();

    // abort() only if the backend has actually been constructed. Same for
    // stop(): with no backend nothing can still be writing, so the spawner's
    // cleanup has nothing to wait for.
    this.backend?.abort();
    const stopped = this.backend?.stop().catch(() => {});

    this.finalizeTerminal('cancelled', reason, stopped);
  }

  snapshot(): {
    workerId: string;
    role: string;
    status: WorkerStatus;
    brief: string;
    model: string;
    report?: string;
    usage: { inputTokens: number; outputTokens: number };
    startedAt?: number;
    endedAt?: number;
    subagentType: string;
    description: string;
    name?: string;
    toolCallCount: number;
    background: boolean;
    oneShot: boolean;
    workspace?: string;
  } {
    return {
      workerId: this.workerId,
      role: this.role,
      status: this.status,
      brief: this.brief,
      model: this.model,
      report: this.report,
      usage: { ...this.usage },
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      subagentType: this.subagentType,
      description: this.description,
      name: this.name,
      toolCallCount: this.toolCallCount,
      background: this.background,
      oneShot: this.oneShot,
      workspace: this.workspace,
    };
  }

  // --- internals ---

  /** Runs one conversational segment to completion, then applies the terminal transition. */
  private async runSegment(message: string): Promise<void> {
    let backend: WorkerBackend;
    try {
      backend = await this.opts.backendPromise;
    } catch (err) {
      this.finalizeFailed(err instanceof Error ? err.message : String(err));
      return;
    }
    this.backend = backend;
    // `workspace` is not set here: the constructor already resolved it off the
    // same promise, so a child snapshotted before its first segment (or
    // cancelled during construction) reports the right thing too.
    // A cancel() may have landed while awaiting construction.
    if (this.finalized) return;

    try {
      for await (const event of backend.chat(message)) {
        // A cancel() may have landed between events.
        if (this.finalized) return;
        this.processEvent(event);
        if (this.finalized) return;
      }
    } catch (err) {
      if (this.finalized) return;
      this.finalizeFailed(err instanceof Error ? err.message : String(err));
      return;
    }

    // --- Atomic terminal transition (no awaits in this block) ---
    if (this.finalized) return;
    if (this.steerQueue.length > 0) {
      const next = this.steerQueue.shift() as string;
      // Stay running; drive the next segment. The recursive call's initial
      // awaits happen AFTER this synchronous block returns.
      void this.runSegment(next);
      return;
    }
    if (this.status === 'waiting_input') {
      // Keep waiting; the pending question controls the next transition.
      return;
    }
    this.finalizeDone();
  }

  private processEvent(event: AgentEvent): void {
    this.lastEventSummary = summarize(event);
    if (event.type === 'tool_use_start') {
      this.toolCallCount++;
      // Enforcement is best-effort and lands AFTER the offending call: by the time
      // the handle sees tool_use_start, pi has already dispatched that call, and
      // pi's abort is cooperative, so the offending call — and possibly further
      // parallel calls in the same batch — will complete even after abort(). With
      // maxTurns: 2, the second call is allowed and the third trips. The abort
      // stops the child from issuing more calls, but runSegment's post-processEvent
      // `finalized` check keeps this segment from also finalizing as `done`.
      if (this.maxTurns !== undefined && this.maxTurns > 0 && this.toolCallCount > this.maxTurns) {
        this.backend?.abort();
        this.finalizeMaxTurns();
        return;
      }
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

  /**
   * Terminal transition for a child that ran out of turn budget. Unlike
   * `failed`, the work is not lost: the report keeps whatever the child had
   * produced, behind a marker saying so, and the child can resume via
   * `send_message` (which starts a fresh segment; actual resumability is C4).
   *
   * The abort was already issued by processEvent just before this call. This
   * defers the spawner notification (via settled) until the backend has stopped
   * (or grace period expires), since pi's abort is cooperative and the child may
   * still be writing to its worktree. Without this deferral, a spawner told to
   * clean up immediately could delete the worktree out from under a live process.
   */
  private finalizeMaxTurns(): void {
    if (this.finalized) return;
    this.finalized = true;
    this.status = 'max_turns';
    this.report = `${MAX_TURNS_PARTIAL_MARKER}\n\n${this.report ?? ''}`;
    this.endedAt = Date.now();
    this.stopHeartbeat();

    const stopped = this.backend?.stop().catch(() => {});

    this.finalizeTerminal('max_turns', this.report, stopped);
  }

  /**
   * The ONE terminal transition, shared by finalizeDone / finalizeFailed /
   * finalizeMaxTurns / cancel. Every terminal path emits `worker_done` and its `subagent_finished`
   * twin, runs the `subagentStop` hook, notifies the spawner, calls onTerminal
   * and resolves the terminal promise — in that order, exactly once.
   *
   * It is one function on purpose. `notifyFinished` is what takes an isolated
   * child's worktree down, so a future terminal status (`interrupted`) that
   * hand-rolled five of these six steps would leak a directory per worker and
   * look correct doing it. Route new terminal statuses through here and that is
   * structurally impossible.
   *
   * `settled` is cancel's bounded wait (see cancel): when present the spawner
   * notification is deferred until the backend has stopped, or the grace period
   * expires, whichever comes first. Callers must have set `finalized`, `status`
   * and `endedAt` before calling.
   */
  private finalizeTerminal(
    status: TerminalWorkerStatus,
    report: string,
    settled?: Promise<void>,
  ): void {
    // Settle any pending question waiter with a status-derived error message.
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
    this.opts.onTerminal(this);
    this.terminal.resolve();
  }

  /**
   * Fire the spawner notification once `settled` settles, or after the cancel
   * grace period — whichever is first. The timeout is not a nicety: an
   * unconditional wait on a `stop()` that never resolves would leak the child's
   * worktree for the lifetime of the gateway.
   */
  private notifyFinishedAfter(settled: Promise<void>): void {
    const graceMs = this.opts.cancelStopGraceMs ?? DEFAULT_CANCEL_STOP_GRACE_MS;
    const grace = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, graceMs);
      if (typeof timer === 'object' && 'unref' in timer) timer.unref();
    });
    void Promise.race([settled, grace]).then(
      () => this.notifyFinished(),
      () => this.notifyFinished(),
    );
  }

  /**
   * The spawner-facing terminal notification. Called from EVERY finalizer, in
   * their synchronous blocks, and deliberately fire-and-forget: `cancel()` is
   * documented never to await, and a spawner's cleanup must not be able to
   * break — or delay — the worker's terminal transition.
   */
  private notifyFinished(): void {
    const hook = this.opts.onFinished;
    if (!hook) return;
    try {
      void Promise.resolve(hook({ ...this.opts.spec, workerStatus: this.status })).catch(() => {});
    } catch {
      // A synchronous throw from the hook is the spawner's problem, not the
      // worker's: the terminal transition has already been reported.
    }
  }

  private isTerminal(): boolean {
    return this.finalized;
  }

  private clearQuestion(): void {
    this.questionWaiter?.cleanup();
    this.questionWaiter = undefined;
    this.pendingQuestion = undefined;
  }

  /**
   * Restore 'running' after a question rejection (timeout / signal-abort) so the
   * segment's terminal transition does NOT take the keep-waiting branch forever
   * and strand the worker in 'waiting_input'. Mirrors answerQuestion's restore.
   * Guarded on `!finalized`: cancel()/finalizeFailed have already moved status to
   * a terminal value and must win, so this never resurrects a terminalizing worker.
   */
  private restoreRunningAfterQuestion(): void {
    if (this.finalized) return;
    if (this.status === 'waiting_input') {
      this.status = 'running';
      this.emitStatus('running');
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    const timer = setInterval(() => {
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

  /**
   * Every non-terminal status transition (and the heartbeat) emits the legacy
   * `worker_status` plus its `subagent_progress` twin. No second timer: the two
   * always ride together so a client can follow either one alone.
   */
  private emitStatus(
    status: 'running' | 'waiting_input',
    detail?: string,
    question?: string,
  ): void {
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
      subagentId: this.workerId,
      status,
      toolCallCount: this.toolCallCount,
      elapsedMs: Date.now() - (this.startedAt ?? Date.now()),
      ...(detail !== undefined ? { detail } : {}),
      ...(question !== undefined ? { question } : {}),
    });
  }

  /** ISO start stamp for the subagent_* events; `now` when never started. */
  private startedAtIso(): string {
    return new Date(this.startedAt ?? Date.now()).toISOString();
  }

  /**
   * The `subagent_finished` twin of `worker_done`, pushed straight after it so
   * legacy decoders see their event first. Carries the TRUE terminal status,
   * which `worker_done` may have had to flatten (see legacyWorkerDoneStatus).
   */
  private emitFinished(status: TerminalWorkerStatus, report: string): void {
    this.emit({
      type: 'subagent_finished',
      subagentId: this.workerId,
      ...(this.name !== undefined ? { name: this.name } : {}),
      subagentType: this.subagentType,
      description: this.description,
      status,
      report,
      usage: this.usage,
      toolCallCount: this.toolCallCount,
      startedAt: this.startedAtIso(),
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
