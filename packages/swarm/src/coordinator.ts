import { randomUUID } from 'node:crypto';
import type { AgentEvent } from '@dash/agent';
import { AsyncChannel } from './channel.js';
import { type RunSnapshot, type RunSummary, SwarmRun } from './run.js';
import { createAskOrchestratorTool } from './tools.js';
import type { SwarmCaps, SwarmEventLogSink, WorkerFactory, WorkerStatus } from './types.js';
import type { WorkerHandleOptions } from './worker-handle.js';

export type { RunSnapshot, RunSummary } from './run.js';

/** The full universe of tools a worker may ever be granted. */
const UNIVERSE = [
  'read',
  'bash',
  'edit',
  'write',
  'grep',
  'find',
  'ls',
  'web_fetch',
  'web_search',
] as const;

/** The tools the orchestrator has by default (when config.tools is unset). */
const DEFAULT_TOOL_NAMES = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'] as const;

/** The default subset granted to a worker when it requests no tools. */
const DEFAULT_WORKER_TOOLS = ['read', 'grep', 'find', 'ls'] as const;

/** Hard-coded cap defaults, lowest precedence. */
const HARD_DEFAULT_CAPS: SwarmCaps = {
  maxConcurrentWorkers: 8,
  maxWorkersPerRun: 24,
  maxSteersPerWorker: 10,
  maxRunSeconds: 1800,
};

const DEFAULT_GLOBAL_MAX_CONCURRENT = 16;
const DEFAULT_WAIT_TIMEOUT_SECONDS = 300;
const RING_BUFFER_SIZE = 20;

export interface AttachOptions {
  agentId: string;
  agentName: string;
  conversationId: string;
  /** For out-of-band event-log keying on the consumer-gone finalize path. */
  messageId?: string;
  /** Cooperative abort of the orchestrator (pool entry backend.abort). */
  orchestratorAbort?: () => void;
  /** Live registry read of the agent's enabled/disabled gate. */
  getAgentGate?: () => { enabled: boolean; disabled: boolean };
  caps?: Partial<SwarmCaps>;
  allowedModels?: string[];
  orchestratorModel: string;
  orchestratorFallbackModels?: string[];
  /** The orchestrator's own tool grant (config.tools ?? undefined). */
  orchestratorTools?: string[];
  /** Workspace path handed to spawned workers. */
  workspace?: string;
}

export interface SwarmAttachment {
  readonly runIdHint: string;
  channel: AsyncChannel<AgentEvent>;
  /** Finalize under this attachment's ownership. consumerAlive=true only on normal completion. */
  finalize(opts: { consumerAlive: boolean }): void;
  /** Fires on finalize / wall-clock — for in-flight tool settlement. */
  readonly closed: AbortSignal;
  readonly live: boolean;
}

/** Per-key live turn state. Owns the authoritative identity + (lazily) the run. */
interface LiveTurn {
  readonly opts: AttachOptions;
  readonly caps: SwarmCaps;
  readonly runIdHint: string;
  readonly closedController: AbortController;
  /** Channel handed to the attachment before its first spawn creates the run. */
  readonly preRunChannel: AsyncChannel<AgentEvent>;
  run?: SwarmRun;
  finalized: boolean;
}

export interface SwarmCoordinatorOptions {
  workerFactory: WorkerFactory;
  eventLog?: SwarmEventLogSink;
  globalMaxConcurrentWorkers?: number;
  defaultCaps?: Partial<SwarmCaps>;
  hooks?: WorkerHandleOptions['hooks'];
  /** Called on run state transitions (spawn, worker terminal, finalize). */
  onRunChanged?(agentId: string, runId: string): void;
}

function key(agentId: string, conversationId: string): string {
  return `${agentId}/${conversationId}`;
}

/** A permanently-closed channel handed to non-authoritative attachments. */
function deadChannel<T>(): AsyncChannel<T> {
  const ch = new AsyncChannel<T>();
  ch.close();
  return ch;
}

/** An already-aborted signal handed to non-authoritative attachments. */
function abortedSignal(): AbortSignal {
  return AbortSignal.abort();
}

/**
 * Coordinates swarm runs keyed by `${agentId}/${conversationId}`. Enforces the
 * ownership model (only the first/live attachment can spawn or finalize),
 * per-run + global caps, and model/tool validation. Owns the ring buffer of
 * finalized run snapshots for the panel API.
 */
export class SwarmCoordinator {
  private readonly workerFactory: WorkerFactory;
  private readonly eventLog?: SwarmEventLogSink;
  private readonly globalMax: number;
  private readonly defaultCaps: Partial<SwarmCaps>;
  private readonly hooks?: WorkerHandleOptions['hooks'];
  private readonly onRunChanged?: (agentId: string, runId: string) => void;

  /** Live turns keyed by `${agentId}/${conversationId}`. */
  private readonly live = new Map<string, LiveTurn>();
  /** Finalized run snapshots, ring-buffered per agent (most-recent last). */
  private readonly history = new Map<string, RunSnapshot[]>();

  constructor(opts: SwarmCoordinatorOptions) {
    this.workerFactory = opts.workerFactory;
    this.eventLog = opts.eventLog;
    this.globalMax = opts.globalMaxConcurrentWorkers ?? DEFAULT_GLOBAL_MAX_CONCURRENT;
    this.defaultCaps = opts.defaultCaps ?? {};
    this.hooks = opts.hooks;
    this.onRunChanged = opts.onRunChanged;
  }

  // --- attachment / ownership ---

  attach(opts: AttachOptions): SwarmAttachment {
    const k = key(opts.agentId, opts.conversationId);
    const existing = this.live.get(k);
    if (existing && !existing.finalized) {
      // A live attachment already owns this turn: hand back a non-authoritative
      // attachment. Its channel is dead, closed is already aborted, finalize is
      // a no-op, and it can never authorize spawns.
      return {
        runIdHint: existing.runIdHint,
        channel: deadChannel<AgentEvent>(),
        closed: abortedSignal(),
        live: false,
        finalize: () => {},
      };
    }

    const caps = this.mergeCaps(opts.caps);
    // Placeholder channel returned before the first spawn creates the run; once
    // the run exists the `channel` getter returns the run's channel instead.
    const preRunChannel = new AsyncChannel<AgentEvent>();
    const turn: LiveTurn = {
      opts,
      caps,
      runIdHint: randomUUID().slice(0, 8),
      closedController: new AbortController(),
      preRunChannel,
      finalized: false,
    };
    this.live.set(k, turn);

    // The attachment channel is the run's channel once a run exists; before the
    // first spawn there is no run, so we back it with the per-turn placeholder.
    return {
      runIdHint: turn.runIdHint,
      get channel() {
        return turn.run ? turn.run.channel : preRunChannel;
      },
      get closed() {
        return turn.run ? turn.run.closed : turn.closedController.signal;
      },
      get live() {
        return !turn.finalized;
      },
      finalize: (o) => this.finalizeTurn(k, turn, o),
    } as SwarmAttachment;
  }

  private finalizeTurn(k: string, turn: LiveTurn, o: { consumerAlive: boolean }): void {
    // Only the owning (still-registered) turn can finalize. If the map entry has
    // been replaced or the turn is already finalized, this is a no-op.
    const current = this.live.get(k);
    if (current !== turn || turn.finalized) return;
    turn.finalized = true;

    const run = turn.run;
    if (run) {
      const terminalEvents = run.finalize('swarm turn finalized');
      // Out-of-band append only on the consumer-gone path (nothing else logs them).
      const eventLog = this.eventLog;
      const messageId = turn.opts.messageId;
      if (!o.consumerAlive && eventLog && messageId) {
        const { agentId, conversationId } = turn.opts;
        for (const event of terminalEvents) {
          // Fire-and-forget: never await settlement.
          void Promise.resolve(
            eventLog.append(agentId, conversationId, messageId, { type: 'event', event }),
          ).catch(() => {});
        }
      }
      // Snapshot into the ring buffer for the panel API.
      this.pushHistory(turn.opts.agentId, run.snapshot());
      this.onRunChanged?.(turn.opts.agentId, run.runId);
    } else {
      // No run was ever created; still fire the pre-run closed signal + channel.
      if (!turn.closedController.signal.aborted) turn.closedController.abort();
      turn.preRunChannel.close();
    }

    this.live.delete(k);
  }

  // --- tool-facing API (resolved by agentId, conversationId) ---

  spawnWorker(
    agentId: string,
    conversationId: string,
    p: { role: string; brief: string; tools?: string[]; model?: string },
  ): { workerId: string; status: 'spawning' } {
    const k = key(agentId, conversationId);
    const turn = this.live.get(k);
    if (!turn || turn.finalized) {
      throw new Error('swarm turn is closed — cannot spawn');
    }
    // Wall-clock expiry fires the run's `closed` before the attachment's
    // finalize lands; refuse spawns into a run that is already closing so no
    // worker is registered into a dead run.
    if (turn.run?.closed.aborted) {
      throw new Error('swarm turn is closed — cannot spawn');
    }

    // Gate re-read (live registry). Throw when not enabled or disabled.
    if (turn.opts.getAgentGate) {
      const gate = turn.opts.getAgentGate();
      if (!gate.enabled || gate.disabled) {
        throw new Error('swarm is disabled for this agent');
      }
    }

    // Lazily create the run under the live turn.
    const run = this.ensureRun(turn);

    // --- Caps (all synchronous, before any await) ---
    if (run.totalWorkers >= turn.caps.maxWorkersPerRun) {
      throw new Error(
        `swarm run reached its worker limit (${turn.caps.maxWorkersPerRun} workers per run)`,
      );
    }
    if (run.activeCount() >= turn.caps.maxConcurrentWorkers) {
      throw new Error(
        `too many workers running at once (max ${turn.caps.maxConcurrentWorkers}) — wait for workers to finish`,
      );
    }
    if (this.activeWorkerCount() >= this.globalMax) {
      throw new Error(
        `the gateway is at its global worker limit (${this.globalMax}) — wait for workers to finish`,
      );
    }

    const model = this.validateModel(turn, p.model);
    const tools = this.validateTools(turn, p.tools);

    const workerId = randomUUID().slice(0, 8);
    const spec = {
      agentId: turn.opts.agentId,
      agentName: turn.opts.agentName,
      runId: run.runId,
      workerId,
      role: p.role,
      brief: p.brief,
      model,
      workspace: turn.opts.workspace ?? process.cwd(),
      tools,
    };

    // Synchronous registration + sync emits before any await returns to caller.
    // register() builds the handle first and hands it to this callback so the
    // per-worker ask_orchestrator tool (which needs the handle) can be built and
    // threaded into the WorkerSpec before the factory is invoked. The factory
    // promise is chained into a deferred backend promise inside register — it is
    // NOT awaited here, preserving synchronous registration.
    run.register({ spec, hooks: this.hooks }, (handle) =>
      this.workerFactory({
        ...spec,
        extraTools: [createAskOrchestratorTool(handle, run.closed)],
      }),
    );
    // worker_spawned + agent_spawned emitted synchronously into the channel.
    run.channel.push({
      type: 'worker_spawned',
      workerId,
      runId: run.runId,
      role: p.role,
      brief: p.brief,
      model,
    });
    run.channel.push({ type: 'agent_spawned', name: p.role });

    this.onRunChanged?.(turn.opts.agentId, run.runId);

    return { workerId, status: 'spawning' };
  }

  async waitWorkers(
    agentId: string,
    conversationId: string,
    p: { workerIds?: string[]; timeoutSeconds?: number },
    signal?: AbortSignal,
  ): Promise<
    Array<{ workerId: string; status: WorkerStatus; report?: string; question?: string }>
  > {
    const k = key(agentId, conversationId);
    const turn = this.live.get(k);
    const maybeRun = turn?.run;
    if (!maybeRun) {
      // Nothing to wait on.
      return [];
    }
    const run: SwarmRun = maybeRun;

    const referenced = () => {
      const all = run.workerStatuses();
      if (!p.workerIds || p.workerIds.length === 0) return all;
      const set = new Set(p.workerIds);
      return all.filter((w) => set.has(w.workerId));
    };

    const isTerminal = (s: WorkerStatus) => s === 'done' || s === 'failed' || s === 'cancelled';

    const settled = (): boolean => {
      const refs = referenced();
      if (refs.length === 0) return true;
      if (refs.every((w) => isTerminal(w.status))) return true;
      if (refs.some((w) => w.status === 'waiting_input')) return true;
      return false;
    };

    if (settled()) return referenced();

    const timeoutMs = (p.timeoutSeconds ?? DEFAULT_WAIT_TIMEOUT_SECONDS) * 1000;

    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (fn: () => void) => {
        if (done) return;
        done = true;
        cleanup();
        fn();
      };

      // Poll on a microtask-ish interval; worker transitions have no event bus
      // here, so we observe status via a short timer. unref so it never keeps
      // the process alive.
      const poll = setInterval(() => {
        if (settled()) finish(() => resolve(referenced()));
      }, 5);
      if (typeof poll === 'object' && 'unref' in poll) poll.unref();

      const timer = setTimeout(() => {
        finish(() => resolve(referenced()));
      }, timeoutMs);
      if (typeof timer === 'object' && 'unref' in timer) timer.unref();

      const onClosed = () => finish(() => resolve(referenced()));
      const onAbort = () => finish(() => reject(new Error('aborted')));

      run.closed.addEventListener('abort', onClosed, { once: true });
      if (signal) signal.addEventListener('abort', onAbort, { once: true });

      // If already aborted (race), settle immediately.
      if (run.closed.aborted) onClosed();
      else if (signal?.aborted) onAbort();

      function cleanup() {
        clearInterval(poll);
        clearTimeout(timer);
        run.closed.removeEventListener('abort', onClosed);
        if (signal) signal.removeEventListener('abort', onAbort);
      }
    });
  }

  sendToWorker(
    agentId: string,
    conversationId: string,
    p: { workerId: string; message: string },
  ): { ok: boolean; status: WorkerStatus } {
    const turn = this.live.get(key(agentId, conversationId));
    const run = turn?.run;
    if (!run || turn?.finalized) {
      return { ok: false, status: 'cancelled' };
    }
    const handle = run.getHandle(p.workerId);
    if (!handle) return { ok: false, status: 'cancelled' };
    const res = handle.send(p.message);
    return { ok: res.ok, status: handle.status };
  }

  checkWorkers(
    agentId: string,
    conversationId: string,
  ): Array<{ workerId: string; role: string; status: WorkerStatus; detail?: string }> {
    const turn = this.live.get(key(agentId, conversationId));
    const run = turn?.run;
    if (!run) return [];
    return run.workerStatuses().map((w) => ({
      workerId: w.workerId,
      role: w.role,
      status: w.status,
      detail: w.report ?? w.question,
    }));
  }

  // --- panel / management API ---

  getRuns(agentId: string): RunSummary[] {
    const summaries: RunSummary[] = [];
    // Live runs first.
    for (const turn of this.live.values()) {
      if (turn.opts.agentId === agentId && turn.run) summaries.push(turn.run.summary());
    }
    // Then finalized history.
    for (const snap of this.history.get(agentId) ?? []) {
      summaries.push({
        runId: snap.runId,
        agentId: snap.agentId,
        conversationId: snap.conversationId,
        startedAt: snap.startedAt,
        endedAt: snap.endedAt,
        finalized: snap.finalized,
        workerCount: snap.workerCount,
        activeCount: snap.activeCount,
      });
    }
    return summaries;
  }

  getRun(agentId: string, runId: string): RunSnapshot | undefined {
    for (const turn of this.live.values()) {
      if (turn.opts.agentId === agentId && turn.run?.runId === runId) {
        return turn.run.snapshot();
      }
    }
    for (const snap of this.history.get(agentId) ?? []) {
      if (snap.runId === runId) return snap;
    }
    return undefined;
  }

  cancelWorker(agentId: string, runId: string, workerId: string): { ok: boolean; reason?: string } {
    const run = this.findLiveRun(agentId, runId);
    if (!run) return { ok: false, reason: 'run finalized' };
    const handle = run.getHandle(workerId);
    if (!handle) return { ok: false, reason: 'worker terminal' };
    // Shared synchronous check+effect discipline (no await between).
    if (this.isHandleTerminal(handle.status)) return { ok: false, reason: 'worker terminal' };
    handle.cancel('cancelled by panel');
    this.onRunChanged?.(agentId, run.runId);
    return { ok: true };
  }

  sendPanelMessage(
    agentId: string,
    runId: string,
    workerId: string,
    message: string,
  ): { ok: boolean; reason?: string } {
    const run = this.findLiveRun(agentId, runId);
    if (!run) return { ok: false, reason: 'run finalized' };
    const handle = run.getHandle(workerId);
    if (!handle) return { ok: false, reason: 'worker terminal' };
    if (this.isHandleTerminal(handle.status)) return { ok: false, reason: 'worker terminal' };
    const res = handle.send(message);
    if (!res.ok) return { ok: false, reason: res.reason };
    return { ok: true };
  }

  /**
   * Finalize the live swarm turn of ONE conversation — the user cancelled
   * the chat turn. Cancels every non-terminal worker and appends their
   * terminal events to the event log (consumer-gone path) so history
   * replays the cards as Cancelled. Returns whether a live turn existed.
   */
  cancelTurn(agentId: string, conversationId: string): boolean {
    const k = key(agentId, conversationId);
    const turn = this.live.get(k);
    if (!turn || turn.finalized) return false;
    this.finalizeTurn(k, turn, { consumerAlive: false });
    return true;
  }

  cancelRunsFor(agentId: string): void {
    for (const [k, turn] of this.live) {
      if (turn.opts.agentId === agentId) {
        this.finalizeTurn(k, turn, { consumerAlive: false });
      }
    }
  }

  activeWorkerCount(): number {
    let n = 0;
    for (const turn of this.live.values()) {
      if (turn.run) n += turn.run.activeCount();
    }
    return n;
  }

  /**
   * The live `SwarmRun` for a conversation, if one exists (a spawn has occurred
   * and the turn is not finalized). The gateway uses this to merge the run's
   * event channel into the orchestrator stream.
   */
  getLiveRun(agentId: string, conversationId: string): SwarmRun | undefined {
    const turn = this.live.get(key(agentId, conversationId));
    if (!turn || turn.finalized) return undefined;
    return turn.run;
  }

  stop(): void {
    for (const [k, turn] of this.live) {
      this.finalizeTurn(k, turn, { consumerAlive: false });
    }
  }

  // --- internals ---

  private ensureRun(turn: LiveTurn): SwarmRun {
    if (turn.run) return turn.run;
    const run = new SwarmRun({
      runId: turn.runIdHint,
      agentId: turn.opts.agentId,
      conversationId: turn.opts.conversationId,
      caps: turn.caps,
      channel: turn.preRunChannel,
      orchestratorAbort: turn.opts.orchestratorAbort,
      onWorkerTerminal: (r) => this.onRunChanged?.(turn.opts.agentId, r.runId),
    });
    turn.run = run;
    return run;
  }

  private mergeCaps(perAttach?: Partial<SwarmCaps>): SwarmCaps {
    return {
      ...HARD_DEFAULT_CAPS,
      ...this.defaultCaps,
      ...(perAttach ?? {}),
    };
  }

  private validateModel(turn: LiveTurn, requested?: string): string {
    const model = requested ?? turn.opts.orchestratorModel;
    const allowed = new Set<string>([
      turn.opts.orchestratorModel,
      ...(turn.opts.orchestratorFallbackModels ?? []),
      ...(turn.opts.allowedModels ?? []),
    ]);
    if (!allowed.has(model)) {
      throw new Error(
        `model "${model}" is not allowed for swarm workers (allowed: ${[...allowed].join(', ')})`,
      );
    }
    return model;
  }

  private validateTools(turn: LiveTurn, requested?: string[]): string[] {
    if (!requested || requested.length === 0) {
      return [...DEFAULT_WORKER_TOOLS];
    }
    const universe = new Set<string>(UNIVERSE);
    const orchestratorSet = new Set<string>(turn.opts.orchestratorTools ?? DEFAULT_TOOL_NAMES);
    // Allowed = (orchestratorTools ?? DEFAULT_TOOL_NAMES) ∩ UNIVERSE.
    const allowed = new Set<string>([...orchestratorSet].filter((t) => universe.has(t)));
    for (const tool of requested) {
      if (/^mcp/.test(tool) || /_skill$/.test(tool) || !universe.has(tool)) {
        throw new Error(`tool "${tool}" is not available to swarm workers`);
      }
      if (!allowed.has(tool)) {
        throw new Error(
          `tool "${tool}" is not available to swarm workers (the orchestrator does not have it)`,
        );
      }
    }
    return [...requested];
  }

  private findLiveRun(agentId: string, runId: string): SwarmRun | undefined {
    for (const turn of this.live.values()) {
      if (turn.opts.agentId === agentId && !turn.finalized && turn.run?.runId === runId) {
        return turn.run;
      }
    }
    return undefined;
  }

  private isHandleTerminal(status: WorkerStatus): boolean {
    return status === 'done' || status === 'failed' || status === 'cancelled';
  }

  private pushHistory(agentId: string, snap: RunSnapshot): void {
    const list = this.history.get(agentId) ?? [];
    list.push(snap);
    while (list.length > RING_BUFFER_SIZE) list.shift();
    this.history.set(agentId, list);
  }
}
