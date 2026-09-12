import type { AgentEvent } from '@dash/agent';
import { AsyncChannel } from './channel.js';
import type { ChildHandle, TerminalChildStatus } from './child-handle.js';
import type { SwarmCaps, WorkerSpec, WorkerStatus } from './types.js';

/** A worker's spec at its terminal transition — see `onWorkerFinished`. */
export type FinishedWorkerSpec = Omit<WorkerSpec, 'extraTools'> & { workerStatus: string };

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
   *
   * Carries the terminal `workerStatus`, which the gateway's cleanup reads: a
   * `max_turns` child is resumable, so its worktree is KEPT while every other
   * terminal status releases it.
   */
  onWorkerFinished?(spec: FinishedWorkerSpec): void | Promise<void>;
}

/**
 * A single swarm run: the PER-TURN container of the `ChildHandle`s spawned
 * during one live turn. Owns the event `channel`, the wall-clock timer, and the
 * `closed` `AbortSignal` used to settle in-flight tool calls (wait_workers,
 * ask).
 *
 * It does not own a child's LIFETIME — the coordinator's per-parent registry
 * does, so a child stays addressable after the turn that spawned it ends. What
 * the run owns is the FOREGROUND half of the turn: its `finalize` cancels the
 * foreground children (they are part of the turn) and leaves the background
 * ones running, and it carries every child's events to the parent's stream
 * while there is one to carry them to.
 *
 * Correctness discipline mirrors ChildHandle: `adopt`, `cancelAll`, and
 * `finalize` apply their effects in synchronous blocks with no awaits between a
 * check and its effect. `finalize` publishes one stable promise before invoking
 * callbacks so re-entrant lifecycle barriers join the same teardown, but it
 * never waits for a detached child's driver settlement.
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
  private readonly onWorkerFinished?: (spec: FinishedWorkerSpec) => void | Promise<void>;

  private finalizedAt?: number;
  private finalizationPromise?: Promise<AgentEvent[]>;
  private finalizationEvents: AgentEvent[] = [];

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

  /**
   * Fires on finalize or wall-clock expiry. Consumed by tool settlement.
   *
   * The wall clock here bounds the ORCHESTRATOR's turn. Each child carries the
   * same number as its OWN deadline (see `ChildHandle`), because a detached
   * background child outlives this run and a run-scoped clock would either kill
   * it when the turn ended or never fire for it at all.
   */
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
    // A RESUME builds a second handle over the SAME child conversation and
    // re-adopts it, so the id must not be appended twice: `order` drives every
    // snapshot and the cancel sweep, and a duplicate would list the child twice
    // and cancel it twice.
    if (!this.handles.has(handle.workerId)) this.order.push(handle.workerId);
    this.handles.set(handle.workerId, handle);
  }

  /**
   * Un-adopt a child whose registration failed. `adopt` has already put it in
   * `handles`/`order`, so without this the phantom stays in the run: the
   * coordinator's `terminalizePhantom` emits the terminal pair for it and the
   * run's later `cancelAll` emits a SECOND for the same id, on top of a
   * phantom row in every `snapshot()`.
   */
  forget(workerId: string): void {
    this.handles.delete(workerId);
    const index = this.order.indexOf(workerId);
    if (index >= 0) this.order.splice(index, 1);
  }

  /** Fires `onWorkerTerminal`; the coordinator wires this to a child's terminal. */
  noteTerminal(): void {
    this.onWorkerTerminal?.(this);
  }

  /** Fires `onWorkerFinished`; the coordinator wires this to a child's terminal. */
  noteFinished(spec: FinishedWorkerSpec): void {
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

  /**
   * Cancel this turn's FOREGROUND workers synchronously (their
   * `subagent_finished` is pushed to the channel first).
   *
   * A `background: true` child is deliberately left alone: since Task C4 it is
   * DETACHED from the turn that spawned it (design §5.2 — "you will be notified
   * when it completes"), so the end of that turn is not the end of the child.
   * Its own wall clock, an explicit `cancelChild`, and a delete of its
   * conversation are what stop it.
   */
  cancelAll(reason: string): void {
    for (const id of this.order) {
      const h = this.handles.get(id) as ChildHandle;
      if (h.background) continue;
      if (!TERMINAL.has(h.status)) h.cancel(reason);
    }
  }

  /**
   * Finalize the run. Its state transition is synchronous and idempotent, and
   * it never awaits child-driver settlement. The stable returned promise lets
   * re-entrant shutdown and cancellation callers observe a synchronous abort
   * failure without starting a second teardown.
   *
   * Order: cancel non-terminal workers (their `subagent_finished{cancelled}`
   * lands in the channel first), abort the orchestrator, fire `closed`, close
   * the channel, stop the wall-clock timer.
   *
   * Event-log out-of-band append and ring-buffer snapshotting are owned by the
   * coordinator (which knows the eventLog + messageId) — this method returns
   * the terminal `subagent_finished` events it produced so the coordinator can
   * log them.
   */
  finalize(reason: string): Promise<AgentEvent[]> {
    if (this.finalizationPromise) return this.finalizationPromise;
    // Publish identity before cancel/orchestrator callbacks. Either can
    // synchronously re-enter finalize(), and every caller must join this exact
    // settlement instead of starting a second teardown.
    const finalization = Promise.withResolvers<AgentEvent[]>();
    this.finalizationPromise = finalization.promise;

    try {
      this.finalizedAt = Date.now();

      // Workers still live at entry are the only ones whose `subagent_finished`
      // has not already ridden the live channel. Background children detach and
      // therefore are deliberately excluded from this turn's cancellation set.
      const cancelledHere = new Set(
        this.order.filter((id) => {
          const handle = this.handles.get(id) as ChildHandle;
          return !handle.background && !TERMINAL.has(handle.status);
        }),
      );

      // 1) Cancel foreground children. Background children detach.
      this.cancelAll(reason);

      // 2) Abort the orchestrator (cooperative).
      let abortError: unknown;
      try {
        this.orchestratorAbort?.();
      } catch (error) {
        abortError = error;
      }

      // 3) Fire `closed` for in-flight tool settlement, then close the channel.
      if (!this.closedController.signal.aborted) this.closedController.abort();
      this.channel.close();

      // 4) Stop the wall-clock timer.
      clearTimeout(this.wallClockTimer);

      // Record only the terminal events this finalization produced; earlier
      // terminal transitions already reached the live consumer.
      this.finalizationEvents = this.terminalDoneEvents(cancelledHere);
      if (abortError === undefined) finalization.resolve(this.finalizationEvents);
      else finalization.reject(abortError);
    } catch (error) {
      finalization.reject(error);
    }
    return finalization.promise;
  }

  /** Terminal events synchronously produced by the current finalization. */
  getFinalizationEvents(): readonly AgentEvent[] {
    return this.finalizationEvents;
  }

  private terminalDoneEvents(only: ReadonlySet<string>): AgentEvent[] {
    const events: AgentEvent[] = [];
    // Only reached for handles `cancelAll` just terminalized, so both stamps
    // are set; the fallback keeps the event well-formed rather than trusting it.
    const nowIso = new Date().toISOString();
    for (const id of this.order) {
      if (!only.has(id)) continue;
      const h = this.handles.get(id) as ChildHandle;
      if (!TERMINAL.has(h.status)) continue;
      // `subagent_finished`, not the retired `worker_done` mirror: this return
      // value is the OUT-OF-BAND event-log append on a consumer-gone finalize
      // (`coordinator.ts` logs it), so dropping it rather than reshaping it
      // would cost a child cancelled on a closed socket its persisted terminal
      // row entirely. The five-case status now reaches every client unflattened.
      events.push({
        type: 'subagent_finished',
        subagentId: h.subagentId,
        ...(h.name !== undefined ? { name: h.name } : {}),
        subagentType: h.subagentType,
        description: h.description,
        status: h.status as TerminalChildStatus,
        report: h.report ?? '',
        usage: h.usage,
        toolCallCount: h.toolCallCount,
        startedAt: h.startedAtIso ?? nowIso,
        endedAt: h.endedAtIso ?? nowIso,
      });
    }
    return events;
  }

  private onWallClock(): void {
    if (this.finalized) return;
    // Use the authoritative, stable finalization barrier so a synchronous abort
    // failure cannot escape the timer callback or skip closed/channel cleanup.
    // The attachment's later finalize() call joins this exact settlement and can
    // still observe a cleanup failure after every worker backend is disposed.
    void this.finalize(`run exceeded ${this.caps.maxRunSeconds}s wall clock`).catch(() => {});
  }
}
