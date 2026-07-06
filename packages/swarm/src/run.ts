import type { AgentEvent } from '@dash/agent';
import { AsyncChannel } from './channel.js';
import type { SwarmCaps, WorkerBackend, WorkerStatus } from './types.js';
import { WorkerHandle, type WorkerHandleOptions } from './worker-handle.js';

/** A worker as seen by the panel/management API. */
export interface RunWorkerSnapshot {
  workerId: string;
  role: string;
  status: WorkerStatus;
  brief: string;
  model: string;
  report?: string;
  usage: { inputTokens: number; outputTokens: number };
  startedAt?: number;
  endedAt?: number;
}

/** Lightweight run listing (panel). */
export interface RunSummary {
  runId: string;
  agentId: string;
  conversationId: string;
  startedAt: number;
  endedAt?: number;
  finalized: boolean;
  workerCount: number;
  activeCount: number;
}

/** Full run detail (panel), including per-worker snapshots. */
export interface RunSnapshot extends RunSummary {
  workers: RunWorkerSnapshot[];
}

const TERMINAL: ReadonlySet<WorkerStatus> = new Set<WorkerStatus>(['done', 'failed', 'cancelled']);

export interface SwarmRunOptions {
  runId: string;
  agentId: string;
  conversationId: string;
  caps: SwarmCaps;
  /**
   * The event channel for this run. When the coordinator hands over the
   * attachment's pre-run placeholder channel here, channel identity stays stable
   * across the pre-run → run transition (a consumer that grabbed the channel
   * before the first spawn still sees the events). Defaults to a fresh channel.
   */
  channel?: AsyncChannel<AgentEvent>;
  /** Cooperative abort of the orchestrator (pool entry backend.abort). */
  orchestratorAbort?: () => void;
  /** Invoked whenever a worker's status becomes terminal. */
  onWorkerTerminal?(run: SwarmRun): void;
}

/**
 * A single swarm run: the container of `WorkerHandle`s spawned during one live
 * turn. Owns the event `channel`, the wall-clock timer, and the `closed`
 * `AbortSignal` used to settle in-flight tool calls (wait_workers, ask).
 *
 * Correctness discipline mirrors WorkerHandle: `register`, `cancelAll`, and
 * `finalize` apply their effects in synchronous blocks with no awaits between a
 * check and its effect, and teardown NEVER awaits worker settlement.
 */
export class SwarmRun {
  readonly runId: string;
  readonly agentId: string;
  readonly conversationId: string;
  readonly channel: AsyncChannel<AgentEvent>;
  readonly startedAt = Date.now();

  private readonly caps: SwarmCaps;
  private readonly handles = new Map<string, WorkerHandle>();
  /** Insertion order for stable snapshots. */
  private readonly order: string[] = [];
  private readonly closedController = new AbortController();
  private readonly wallClockTimer: ReturnType<typeof setTimeout>;
  private readonly orchestratorAbort?: () => void;
  private readonly onWorkerTerminal?: (run: SwarmRun) => void;

  private finalizedAt?: number;

  constructor(opts: SwarmRunOptions) {
    this.runId = opts.runId;
    this.agentId = opts.agentId;
    this.conversationId = opts.conversationId;
    this.channel = opts.channel ?? new AsyncChannel<AgentEvent>();
    this.caps = opts.caps;
    this.orchestratorAbort = opts.orchestratorAbort;
    this.onWorkerTerminal = opts.onWorkerTerminal;

    const timer = setTimeout(() => this.onWallClock(), this.caps.maxRunSeconds * 1000);
    if (typeof timer === 'object' && 'unref' in timer) timer.unref();
    this.wallClockTimer = timer;
  }

  /** Fires on finalize or wall-clock expiry. Consumed by tool settlement. */
  get closed(): AbortSignal {
    return this.closedController.signal;
  }

  get finalized(): boolean {
    return this.finalizedAt !== undefined;
  }

  /** Total workers ever spawned in this run (terminal ones included). */
  get totalWorkers(): number {
    return this.handles.size;
  }

  /** Non-terminal workers (spawning/running/waiting_input). */
  activeCount(): number {
    let n = 0;
    for (const h of this.handles.values()) {
      if (!TERMINAL.has(h.status)) n++;
    }
    return n;
  }

  getHandle(workerId: string): WorkerHandle | undefined {
    return this.handles.get(workerId);
  }

  /**
   * Synchronously registers and starts a worker. The worker's `backendPromise`
   * is produced by `makeBackend`, which receives the freshly-built (not yet
   * started) `WorkerHandle` so the caller can construct handle-dependent extra
   * tools (e.g. ask_orchestrator) and hand them to the worker factory. The
   * factory promise MUST NOT be awaited by the caller before this returns — it
   * is chained into a deferred backend promise the WorkerHandle drives
   * internally. If `makeBackend` throws synchronously the failure is folded into
   * the backend promise (a rejection), never an unhandled throw, so the handle
   * fails cleanly instead of the spawn escaping. worker_spawned + agent_spawned
   * are emitted by the coordinator around this call synchronously.
   */
  register(
    handleOpts: Omit<
      WorkerHandleOptions,
      'emit' | 'onTerminal' | 'maxSteers' | 'backendPromise'
    > & {
      maxSteers?: number;
    },
    makeBackend: (handle: WorkerHandle) => Promise<WorkerBackend>,
  ): WorkerHandle {
    const { promise: backendPromise, resolve: resolveBackend } =
      Promise.withResolvers<WorkerBackend>();
    const handle = new WorkerHandle({
      ...handleOpts,
      backendPromise,
      maxSteers: handleOpts.maxSteers ?? this.caps.maxSteersPerWorker,
      emit: (event) => this.channel.push(event),
      onTerminal: () => this.onWorkerTerminal?.(this),
    });
    this.handles.set(handle.workerId, handle);
    this.order.push(handle.workerId);
    // Chain the factory promise into the deferred. A synchronous throw from
    // makeBackend (or a rejected promise) becomes a rejected backendPromise,
    // which WorkerHandle.runSegment catches → finalizeFailed. Never an unhandled
    // rejection and never a throw out of register().
    try {
      resolveBackend(makeBackend(handle));
    } catch (err) {
      resolveBackend(Promise.reject(err instanceof Error ? err : new Error(String(err))));
    }
    handle.start();
    return handle;
  }

  /** Snapshot of every worker's status (tool-facing check/wait). */
  workerStatuses(): Array<{
    workerId: string;
    role: string;
    status: WorkerStatus;
    report?: string;
    question?: string;
  }> {
    return this.order.map((id) => {
      const h = this.handles.get(id) as WorkerHandle;
      return {
        workerId: h.workerId,
        role: h.role,
        status: h.status,
        report: h.report,
        question: h.pendingQuestion,
      };
    });
  }

  snapshot(): RunSnapshot {
    const workers = this.order.map((id) => (this.handles.get(id) as WorkerHandle).snapshot());
    return {
      ...this.summary(),
      workers,
    };
  }

  summary(): RunSummary {
    return {
      runId: this.runId,
      agentId: this.agentId,
      conversationId: this.conversationId,
      startedAt: this.startedAt,
      endedAt: this.finalizedAt,
      finalized: this.finalized,
      workerCount: this.handles.size,
      activeCount: this.activeCount(),
    };
  }

  /** Cancel every non-terminal worker synchronously (worker_done pushed to channel first). */
  cancelAll(reason: string): void {
    for (const id of this.order) {
      const h = this.handles.get(id) as WorkerHandle;
      if (!TERMINAL.has(h.status)) h.cancel(reason);
    }
  }

  /**
   * Finalize the run. Synchronous, idempotent, NEVER awaits worker settlement.
   * Order: cancel non-terminal workers (their worker_done{cancelled} lands in
   * the channel first), abort the orchestrator, fire `closed`, close the
   * channel, stop the wall-clock timer.
   *
   * Event-log out-of-band append and ring-buffer snapshotting are owned by the
   * coordinator (which knows the eventLog + messageId) — this method returns the
   * terminal worker_done events it produced so the coordinator can log them.
   */
  finalize(reason: string): AgentEvent[] {
    if (this.finalized) return [];
    this.finalizedAt = Date.now();

    // Workers still live at entry are the only ones whose worker_done has not
    // already ridden the live channel — already-terminal workers emitted theirs
    // at completion time. Snapshot before cancelAll terminalizes them so the
    // returned events cover exactly what THIS call produced (no double-logging).
    const cancelledHere = new Set(
      this.order.filter((id) => !TERMINAL.has((this.handles.get(id) as WorkerHandle).status)),
    );

    // 1) Cancel non-terminal workers; worker_done{cancelled} lands in the channel first.
    this.cancelAll(reason);

    // 2) Abort the orchestrator (cooperative).
    this.orchestratorAbort?.();

    // 3) Fire `closed` for in-flight tool settlement, then close the channel.
    if (!this.closedController.signal.aborted) this.closedController.abort();
    this.channel.close();

    // 4) Stop the wall-clock timer.
    clearTimeout(this.wallClockTimer);

    // Return ONLY the worker_done events this call produced (cancellations) for
    // optional out-of-band logging — events from earlier terminal transitions
    // already reached the consumer via the live channel.
    return this.terminalDoneEvents(cancelledHere);
  }

  private terminalDoneEvents(only: ReadonlySet<string>): AgentEvent[] {
    const events: AgentEvent[] = [];
    for (const id of this.order) {
      if (!only.has(id)) continue;
      const h = this.handles.get(id) as WorkerHandle;
      if (!TERMINAL.has(h.status)) continue;
      const status = h.status as 'done' | 'failed' | 'cancelled';
      events.push({
        type: 'worker_done',
        workerId: h.workerId,
        runId: this.runId,
        role: h.role,
        status,
        report: h.report ?? '',
        usage: h.usage,
      });
    }
    return events;
  }

  private onWallClock(): void {
    if (this.finalized) return;
    // Wall-clock expiry: cancel all workers, abort orchestrator, fire closed.
    // The attachment's finalize() runs later (idempotent) via the merge wrapper.
    this.cancelAll(`run exceeded ${this.caps.maxRunSeconds}s wall clock`);
    this.orchestratorAbort?.();
    if (!this.closedController.signal.aborted) this.closedController.abort();
  }
}
