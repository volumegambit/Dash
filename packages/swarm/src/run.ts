import type { AgentEvent } from '@dash/agent';
import { AsyncChannel } from './channel.js';
import type { ChildHandle } from './child-handle.js';
import type { SwarmCaps, WorkerSpec, WorkerStatus } from './types.js';
import { legacyWorkerDoneStatus } from './worker-handle.js';

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
  /** Resolved subagent type ('general-purpose' when the caller named none). */
  subagentType: string;
  /** 3-5 word UI label; falls back to the role. */
  description: string;
  /** Addressable name, when the caller gave one. */
  name?: string;
  toolCallCount: number;
  background: boolean;
  oneShot: boolean;
  /**
   * The directory the worker ran in — its own worktree when it was isolated,
   * the shared workspace otherwise. Optional because a snapshot rebuilt from
   * the durable event log (crash recovery) predates the field.
   */
  workspace?: string;
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

const TERMINAL: ReadonlySet<WorkerStatus> = new Set<WorkerStatus>([
  'done',
  'failed',
  'cancelled',
  'interrupted',
  'max_turns',
]);

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
  /**
   * Invoked once per worker terminal transition with that worker's spec, so the
   * spawner can undo per-child setup (the gateway's worktree isolation).
   */
  onWorkerFinished?(spec: Omit<WorkerSpec, 'extraTools'>): void | Promise<void>;
}

/**
 * A single swarm run: the PER-TURN container of the `ChildHandle`s spawned
 * during one live turn. Owns the event `channel`, the wall-clock timer, and the
 * `closed` `AbortSignal` used to settle in-flight tool calls (wait_workers,
 * ask).
 *
 * It no longer owns a child's LIFETIME — the coordinator's per-parent registry
 * does, so a child stays addressable after the turn that spawned it ends. The
 * run is what makes a child turn-SCOPED (its `finalize` cancels whatever is
 * still live) and what carries the child's events to the parent's stream.
 *
 * Correctness discipline mirrors ChildHandle: `adopt`, `cancelAll`, and
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
  private readonly handles = new Map<string, ChildHandle>();
  /** Insertion order for stable snapshots. */
  private readonly order: string[] = [];
  private readonly closedController = new AbortController();
  private readonly wallClockTimer: ReturnType<typeof setTimeout>;
  private readonly orchestratorAbort?: () => void;
  private readonly onWorkerTerminal?: (run: SwarmRun) => void;
  private readonly onWorkerFinished?: (
    spec: Omit<WorkerSpec, 'extraTools'>,
  ) => void | Promise<void>;

  private finalizedAt?: number;

  constructor(opts: SwarmRunOptions) {
    this.runId = opts.runId;
    this.agentId = opts.agentId;
    this.conversationId = opts.conversationId;
    this.channel = opts.channel ?? new AsyncChannel<AgentEvent>();
    this.caps = opts.caps;
    this.orchestratorAbort = opts.orchestratorAbort;
    this.onWorkerTerminal = opts.onWorkerTerminal;
    this.onWorkerFinished = opts.onWorkerFinished;

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

  getHandle(workerId: string): ChildHandle | undefined {
    return this.handles.get(workerId);
  }

  /**
   * Index a child under this run, synchronously and before it starts. The
   * coordinator owns construction (the handle needs the driver, the parent
   * channel lookup and the cross-turn registry) and calls `start()` itself once
   * the driver has the child's spec — so `adopt` never runs anything, it only
   * makes the child visible to `wait_workers`, the panel snapshot and
   * `finalize`'s cancel sweep.
   */
  adopt(handle: ChildHandle): void {
    this.handles.set(handle.workerId, handle);
    this.order.push(handle.workerId);
  }

  /** Fires `onWorkerTerminal`; the coordinator wires this to a child's terminal. */
  noteTerminal(): void {
    this.onWorkerTerminal?.(this);
  }

  /** Fires `onWorkerFinished`; the coordinator wires this to a child's terminal. */
  noteFinished(spec: Omit<WorkerSpec, 'extraTools'>): void {
    this.onWorkerFinished?.(spec);
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
      const h = this.handles.get(id) as ChildHandle;
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
    const workers = this.order.map((id) => (this.handles.get(id) as ChildHandle).snapshot());
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
      const h = this.handles.get(id) as ChildHandle;
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
      this.order.filter((id) => !TERMINAL.has((this.handles.get(id) as ChildHandle).status)),
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
      const h = this.handles.get(id) as ChildHandle;
      if (!TERMINAL.has(h.status)) continue;
      events.push({
        type: 'worker_done',
        workerId: h.workerId,
        runId: this.runId,
        role: h.role,
        // Legacy mirror: flattened for the iOS / MC decoders (see the helper).
        status: legacyWorkerDoneStatus(h.status),
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
