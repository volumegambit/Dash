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
  hooks?: {
    subagentStart?(w: { workerId: string; role: string }): void;
    subagentStop?(w: { workerId: string; role: string; status: string }): void;
  };
}

const DEFAULT_HEARTBEAT_MS = 10_000;

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

  status: WorkerStatus = 'spawning';
  report?: string;
  usage: { inputTokens: number; outputTokens: number } = { inputTokens: 0, outputTokens: 0 };
  steersUsed = 0;
  pendingQuestion?: string;

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
        reject(new Error(`ask_orchestrator timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      if (typeof timer === 'object' && 'unref' in timer) timer.unref();

      const onAbort = () => {
        this.clearQuestion();
        reject(new Error('ask_orchestrator aborted'));
      };
      if (signal) {
        if (signal.aborted) {
          clearTimeout(timer);
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
   * fires onTerminal, then fire-and-forget stop().
   */
  cancel(reason: string): void {
    if (this.finalized) return;
    this.finalized = true;
    this.status = 'cancelled';
    this.report = reason;
    this.endedAt = Date.now();
    this.stopHeartbeat();

    const waiter = this.questionWaiter;
    if (waiter) {
      this.clearQuestion();
      waiter.reject(new Error(`worker cancelled: ${reason}`));
    }

    // abort() only if the backend has actually been constructed.
    this.backend?.abort();

    this.emit({
      type: 'worker_done',
      workerId: this.workerId,
      runId: this.runId,
      role: this.role,
      status: 'cancelled',
      report: reason,
      usage: this.usage,
    });
    this.opts.hooks?.subagentStop?.({
      workerId: this.workerId,
      role: this.role,
      status: 'cancelled',
    });
    this.opts.onTerminal(this);
    this.terminal.resolve();

    // Fire-and-forget: never await the cooperative stop.
    this.backend?.stop().catch(() => {});
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
    this.clearQuestion();
    this.emit({
      type: 'worker_done',
      workerId: this.workerId,
      runId: this.runId,
      role: this.role,
      status: 'done',
      report: this.report ?? '',
      usage: this.usage,
    });
    this.opts.hooks?.subagentStop?.({ workerId: this.workerId, role: this.role, status: 'done' });
    this.opts.onTerminal(this);
    this.terminal.resolve();
  }

  private finalizeFailed(message: string): void {
    if (this.finalized) return;
    this.finalized = true;
    this.status = 'failed';
    this.report = message;
    this.endedAt = Date.now();
    this.stopHeartbeat();
    const waiter = this.questionWaiter;
    if (waiter) {
      this.clearQuestion();
      waiter.reject(new Error(`worker failed: ${message}`));
    }
    this.emit({
      type: 'worker_done',
      workerId: this.workerId,
      runId: this.runId,
      role: this.role,
      status: 'failed',
      report: message,
      usage: this.usage,
    });
    this.opts.hooks?.subagentStop?.({ workerId: this.workerId, role: this.role, status: 'failed' });
    this.opts.onTerminal(this);
    this.terminal.resolve();
  }

  private isTerminal(): boolean {
    return this.finalized;
  }

  private clearQuestion(): void {
    this.questionWaiter?.cleanup();
    this.questionWaiter = undefined;
    this.pendingQuestion = undefined;
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
