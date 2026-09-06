import { randomUUID } from 'node:crypto';
import type { AgentEvent } from '@dash/agent';
import { AsyncChannel } from './channel.js';
import { ChildHandle } from './child-handle.js';
import { childConversationId } from './child-id.js';
import type { NotificationDriver } from './notifications.js';
import {
  type DeliveryOutcome,
  composeNotificationText,
  notificationInitialEvents,
} from './notifications.js';
import { ALWAYS_AVAILABLE_TOOLS, UNIVERSE, parentBuiltinTools } from './resolve-spawn.js';
import {
  type RunSnapshot,
  type RunSummary,
  type RunWorkerSnapshot,
  SwarmRun,
  type SwarmRunOptions,
} from './run.js';
import { DEFAULT_SUBAGENT_TYPE } from './subagent-status.js';
import { createAskOrchestratorTool } from './tools.js';
import type {
  ChildSnapshot,
  ChildSpec,
  ChildTurnDriver,
  SwarmCaps,
  SwarmEventLogSink,
  SwarmHooks,
  WorkerStatus,
} from './types.js';
import { ChildTurnStartError } from './types.js';

export type { RunSnapshot, RunSummary, RunWorkerSnapshot } from './run.js';

/**
 * The default subset granted to a worker that names NO tools at all, before it
 * is intersected with what the orchestrator itself holds (see `validateTools`).
 */
const DEFAULT_WORKER_TOOLS = ['read', 'grep', 'find', 'ls'] as const;

/** Membership sets for `validateTools`, so it can name WHY a tool was refused. */
const UNIVERSE_SET: ReadonlySet<string> = new Set<string>(UNIVERSE);
const ALWAYS_AVAILABLE_SET: ReadonlySet<string> = new Set<string>(ALWAYS_AVAILABLE_TOOLS);

/** Hard-coded cap defaults, lowest precedence. */
const HARD_DEFAULT_CAPS: SwarmCaps = {
  maxConcurrentWorkers: 8,
  maxWorkersPerRun: 24,
  maxSteersPerWorker: 10,
  maxRunSeconds: 1800,
  maxDepth: 3,
};

/**
 * How many terminal children of one conversation stay addressable in memory.
 * The durable record is the child's own conversation, which the driver can
 * always list; this bound only keeps a long conversation's finished children
 * from pinning their handles forever.
 */
const MAX_RETAINED_CHILDREN_PER_PARENT = 64;

/**
 * How many PARENT conversations keep a child bucket in memory. Without a bound
 * across conversations the per-parent bound is no bound at all: a gateway that
 * has served thousands of conversations, each of which spawned one child,
 * retains every one of those handles — with its resolved spec and its full
 * report string — for the process's lifetime. Buckets are evicted
 * least-recently-spawned first and ONLY when every child in them is terminal.
 */
const MAX_TRACKED_PARENT_CONVERSATIONS = 256;

/**
 * How many TERMINAL children the delegation roster names, on top of every live
 * one. The roster is rebuilt and inlined into the parent's system prompt on
 * EVERY turn, so an unbounded list is a token and latency cost that grows
 * monotonically with the age of a conversation — the one dimension no test
 * exercises. Live children are never dropped: they are the `send_message`
 * targets the roster exists to advertise.
 */
const ROSTER_MAX_TERMINAL_CHILDREN = 10;

const DEFAULT_GLOBAL_MAX_CONCURRENT = 16;
const DEFAULT_WAIT_TIMEOUT_SECONDS = 300;
/** waitWorker waits on one named child for as long as the turn can live. */
const WAIT_WORKER_TIMEOUT_SECONDS = 24 * 3600;
const RING_BUFFER_SIZE = 20;

const TERMINAL_STATUSES: ReadonlySet<WorkerStatus> = new Set<WorkerStatus>([
  'done',
  'failed',
  'cancelled',
  'interrupted',
  'max_turns',
]);

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
  /**
   * Fully-qualified `server__tool` MCP names the orchestrator holds. The child
   * grant is bounded by this list; UNSET MEANS NONE, so a spawn that asks for
   * MCP tools is refused rather than trusted. Fail-closed on purpose: the
   * `agent` tool computes the child's MCP grant from its own parent context,
   * and this is the coordinator-side re-check that the two agree.
   */
  orchestratorMcpTools?: string[];
  /** Workspace path handed to spawned workers. */
  workspace?: string;
  /**
   * Events to inject into the attachment's channel before the first orchestrator
   * event. Used for notification turns to inject subagent_finished events onto
   * the parent log first (design §7.3, ruling 5).
   */
  initialEvents?: AgentEvent[];
}

/** Who is spawning, and how deep they already are. */
export interface ParentSpawnContext {
  agentId: string;
  agentName: string;
  /** The parent conversation — a user conversation, or another child's. */
  conversationId: string;
  /** The parent turn doing the spawning; becomes the child's `parentTurnId`. */
  turnId: string;
  /** The PARENT's depth. 0 for a top-level agent, so its children are depth 1. */
  depth: number;
  workspace?: string;
}

/** A spawn as the tools ask for it, before validation resolves it. */
export interface ChildSpawnRequest {
  role: string;
  brief: string;
  tools?: string[];
  /** Fully-qualified `server__tool` names resolved by `resolveChildTools`. */
  mcpTools?: string[];
  /** `agent(a, b)` — the types this child may itself spawn. Unset = all. */
  spawnableTypes?: string[];
  /** Whether this child gets `agent` / `send_message` at all. */
  canSpawn?: boolean;
  model?: string;
  subagentType?: string;
  description?: string;
  name?: string;
  systemPrompt?: string;
  background?: boolean;
  isolation?: 'worktree';
  skipMemory?: boolean;
  maxTurns?: number;
  oneShot?: boolean;
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
  /**
   * Runs children as CONVERSATIONS (design §7.1). The gateway implements it
   * over `ResumableChatHub` + `ConversationService`, so a child persists,
   * replays and stays addressable after the turn that spawned it.
   *
   * The ONLY child transport. Task C4 retired the in-process
   * `WorkerFactory` / `WorkerHandle` path it used to share the coordinator
   * with, so there is exactly one child lifetime.
   */
  childDriver: ChildTurnDriver;
  /**
   * Notification driver for enqueueing and delivering completion notifications
   * (design §7.3). Required for background child support.
   */
  notifications?: NotificationDriver;
  /**
   * Rebuild the resolved spec of a child this process holds no live one for,
   * from whatever the embedder persisted. Called on the RESUME path and by
   * {@link SwarmCoordinator.childSpec}, so a child that finished, was evicted,
   * or belongs to a previous gateway process can run again.
   *
   * The implementation MUST re-intersect the stored grant against what the
   * child's parent holds NOW — not what it held at spawn time. The standing
   * invariant is that a child never holds a tool or an MCP server its parent
   * lacks, and a stored grant is a snapshot of a parent that may since have
   * lost tools. Undefined (or a `undefined` return) means the child cannot be
   * resumed, and the coordinator refuses rather than guessing.
   */
  reconstructChildSpec?(subagentId: string): Omit<ChildSpec, 'extraTools'> | undefined;
  /**
   * The caps configured for an agent, for a resume that happens with NO live
   * parent turn (a panel or API caller). Per-agent `subagents.max*` only ever
   * reach the coordinator through `attach({ caps })`, so without this a resume
   * outside a turn would silently fall back to the gateway defaults.
   */
  resolveCaps?(agentId: string): Partial<SwarmCaps> | undefined;
  /**
   * Each child's heartbeat interval, which is also its liveness poll: a child
   * whose conversation was deleted (a cascading parent delete) is cancelled on
   * the first tick that sees the row gone. Default 10s — the abort is
   * cooperative anyway, so a bounded delay is the cost of not doing a store
   * lookup per streamed event.
   */
  childHeartbeatMs?: number;
  eventLog?: SwarmEventLogSink;
  globalMaxConcurrentWorkers?: number;
  defaultCaps?: Partial<SwarmCaps>;
  hooks?: SwarmHooks;
  /** Called on run state transitions (spawn, worker terminal, finalize). */
  onRunChanged?(agentId: string, runId: string): void;
  /**
   * Called once per worker terminal transition (done, failed, cancelled) with
   * that worker's spec. The gateway hangs worktree cleanup off this: the spawn
   * side created the child's checkout when it built the backend, and every terminal
   * path — cancels included — has to be able to take it down again.
   */
  onWorkerFinished?: SwarmRunOptions['onWorkerFinished'];
}

/**
 * Cap on retained notification-turn initial-event sets. Each holds a full child
 * report, and an entry is only taken when the merge wrapper attaches, so a
 * swarm-disabled agent would otherwise grow this without bound.
 */
const MAX_PENDING_NOTIFICATION_EVENTS = 64;

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
  private readonly driver: ChildTurnDriver;
  private readonly eventLog?: SwarmEventLogSink;
  private readonly globalMax: number;
  private readonly defaultCaps: Partial<SwarmCaps>;
  private readonly hooks?: SwarmHooks;
  private readonly childHeartbeatMs?: number;
  private readonly onRunChanged?: (agentId: string, runId: string) => void;
  private readonly onWorkerFinished?: SwarmRunOptions['onWorkerFinished'];
  private readonly reconstructChildSpec?: (
    subagentId: string,
  ) => Omit<ChildSpec, 'extraTools'> | undefined;
  private readonly resolveCaps?: (agentId: string) => Partial<SwarmCaps> | undefined;
  private readonly notifications?: NotificationDriver;

  /** Live turns keyed by `${agentId}/${conversationId}`. */
  private readonly live = new Map<string, LiveTurn>();
  /** Finalized run snapshots, ring-buffered per agent (most-recent last). */
  private readonly history = new Map<string, RunSnapshot[]>();
  /**
   * EVERY child this process still holds a handle for, keyed by its subagent
   * (= conversation) id. Independent of the run that spawned it: this is what
   * makes `send_message` to a child from an earlier turn resolve.
   */
  private readonly children = new Map<string, ChildHandle>();
  /** Per-parent index, spawn order preserved, bounded per conversation. */
  private readonly childrenByParent = new Map<string, ChildHandle[]>();
  /** The live spec of each child, for the runtime that builds its backend. */
  private readonly childSpecs = new Map<string, ChildSpec>();
  /**
   * Initial events for a notification turn, keyed by the turn id the coordinator
   * minted for it. Written BEFORE the turn starts (the hub attaches
   * synchronously) and taken by the gateway's merge wrapper on attach.
   *
   * BOUNDED: each entry retains a whole report string, and an entry is orphaned
   * whenever a notification turn runs on an agent whose swarm wiring is off (no
   * attach, so nothing takes it). Oldest-first eviction keeps that leak finite.
   */
  private readonly notificationEvents = new Map<string, AgentEvent[]>();

  constructor(opts: SwarmCoordinatorOptions) {
    this.driver = opts.childDriver;
    this.eventLog = opts.eventLog;
    this.globalMax = opts.globalMaxConcurrentWorkers ?? DEFAULT_GLOBAL_MAX_CONCURRENT;
    this.defaultCaps = opts.defaultCaps ?? {};
    this.hooks = opts.hooks;
    this.childHeartbeatMs = opts.childHeartbeatMs;
    this.onRunChanged = opts.onRunChanged;
    this.onWorkerFinished = opts.onWorkerFinished;
    this.reconstructChildSpec = opts.reconstructChildSpec;
    this.resolveCaps = opts.resolveCaps;
    this.notifications = opts.notifications;
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

    // Push initialEvents onto the preRunChannel before anything else.
    if (opts.initialEvents && opts.initialEvents.length > 0) {
      for (const event of opts.initialEvents) {
        preRunChannel.push(event);
      }
    }

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

    // NOT the place to deliver pending notifications. This runs while the
    // finishing turn still holds the conversation lease, so `acceptTurn` is
    // reliably busy; the host drives delivery from its own finishTurn hook
    // (design §7.3, ruling 3), by which point the lease is released.

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

  /**
   * Spawn one child of `parent` (design §7.1). Creates the child's
   * conversation, registers it under the spawning turn AND in the per-parent
   * registry, and starts its first turn with `spec.brief` as the message.
   *
   * Everything up to and including the driver's `startTurn` is SYNCHRONOUS, so
   * a same-batch `wait_workers` or roster read always sees the child.
   *
   * All validation lives here — caps, the depth ceiling, the model allow-list
   * and the tool/MCP subset checks — so `spawn_worker` and the `agent` tool
   * cannot drift apart by going through different gates.
   */
  spawnChild(parent: ParentSpawnContext, p: ChildSpawnRequest): { subagentId: string } {
    const k = key(parent.agentId, parent.conversationId);
    const turn = this.live.get(k);
    if (!turn || turn.finalized) {
      throw new Error('swarm turn is closed — cannot spawn');
    }
    // Wall-clock expiry fires the run's `closed` before the attachment's
    // finalize lands; refuse spawns into a run that is already closing so no
    // child is registered into a dead run.
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
    // Per-CONVERSATION, not per-run: a background child outlives the turn that
    // spawned it, so counting the run's own children would let each new turn
    // start another eight on top of the ones still going.
    if (this.activeChildCount(parent.conversationId) >= turn.caps.maxConcurrentWorkers) {
      throw new Error(
        `too many workers running at once (max ${turn.caps.maxConcurrentWorkers}) — wait for workers to finish`,
      );
    }
    if (this.activeWorkerCount() >= this.globalMax) {
      throw new Error(
        `the gateway is at its global worker limit (${this.globalMax}) — wait for workers to finish`,
      );
    }
    // The nesting ceiling. `resolveChildTools` already withholds `agent` /
    // `send_message` from a child that has reached it, but that grant is only
    // advice to a model: this is the check that a spawn cannot talk its way
    // past. A direct child of a top-level agent is depth 1.
    const depth = parent.depth + 1;
    if (depth > turn.caps.maxDepth) {
      throw new Error(
        `depth limit reached (maxDepth ${turn.caps.maxDepth}) — an agent at depth ` +
          `${parent.depth} cannot spawn a depth-${depth} agent`,
      );
    }

    const model = this.validateModel(turn, p.model);
    const tools = this.validateTools(turn, p.tools);
    const mcpTools = this.validateMcpTools(turn, p.mcpTools);

    const childId = childConversationId();
    const spec: Omit<ChildSpec, 'extraTools'> = {
      agentId: parent.agentId,
      agentName: parent.agentName,
      runId: run.runId,
      // The child's conversation id IS its worker id: one identity for the
      // event stream, the panel, `send_message`, its session dir and its
      // worktree, so nothing has to translate between two of them.
      workerId: childId,
      childConversationId: childId,
      parentConversationId: parent.conversationId,
      parentTurnId: parent.turnId,
      role: p.role,
      brief: p.brief,
      model,
      workspace: parent.workspace ?? turn.opts.workspace ?? process.cwd(),
      tools,
      mcpTools,
      spawnableTypes: p.spawnableTypes,
      canSpawn: p.canSpawn,
      subagentType: p.subagentType,
      description: p.description,
      name: p.name,
      systemPrompt: p.systemPrompt,
      background: p.background,
      isolation: p.isolation,
      skipMemory: p.skipMemory,
      maxTurns: p.maxTurns,
      oneShot: p.oneShot,
      depth,
    };

    // worker_spawned + agent_spawned are pushed synchronously BEFORE the handle
    // starts, so the legacy mirror precedes `subagent_started`: a client that
    // only decodes worker_spawned always has the card before any subagent_*
    // event refers to it.
    this.emitToParent(parent.agentId, parent.conversationId, {
      type: 'worker_spawned',
      workerId: childId,
      runId: run.runId,
      role: p.role,
      brief: p.brief,
      model,
    });
    this.emitToParent(parent.agentId, parent.conversationId, {
      type: 'agent_spawned',
      name: p.role,
    });

    try {
      this.startChild(spec, turn.caps, run);
    } catch (err) {
      // `start()` catches its own failures, so reaching here means the run or
      // the driver refused outright. The worker_spawned card is already on the
      // stream: terminalize the phantom before rethrowing so no client is left
      // with a card that can never complete.
      this.forgetChild(parent.conversationId, childId, run);
      this.terminalizePhantom(run, childId, p, err);
      throw err;
    }

    this.onRunChanged?.(parent.agentId, run.runId);

    return { subagentId: childId };
  }

  /**
   * Build, register and START one child handle — the single path a child ever
   * begins running on, whether this is its first turn (`spawnChild`) or a
   * resume (`sendToChild`). Everything up to and including `start()` is
   * synchronous, so a same-batch read always sees the child.
   *
   * `run` is optional: a resume can happen with no live parent turn (a panel
   * or an API caller), and a child with no run is exactly the detached case —
   * nothing to adopt it, nothing to cancel it at a turn boundary.
   */
  private startChild(
    spec: Omit<ChildSpec, 'extraTools'>,
    caps: SwarmCaps,
    run?: SwarmRun,
    opts: { resumeWith?: string; steersUsed?: number } = {},
  ): ChildHandle {
    const childId = spec.childConversationId;
    const parentConversationId = spec.parentConversationId;
    const handle = new ChildHandle({
      spec,
      driver: this.driver,
      // Looked up PER EMISSION rather than captured: a background child can
      // outlive the turn that spawned it, and after finalize there is no
      // parent channel to push into.
      emit: (event) => this.emitToParent(spec.agentId, parentConversationId, event),
      maxSteers: caps.maxSteersPerWorker,
      // The child's OWN deadline (see ChildHandle.maxRunSeconds): a detached
      // child has to stay bounded once its parent's run is gone.
      maxRunSeconds: caps.maxRunSeconds,
      ...(opts.steersUsed !== undefined ? { steersUsed: opts.steersUsed } : {}),
      ...(opts.resumeWith !== undefined ? { resumeWith: opts.resumeWith } : {}),
      ...(this.childHeartbeatMs !== undefined ? { heartbeatMs: this.childHeartbeatMs } : {}),
      hooks: this.hooks,
      onTerminal: (h) => this.onChildTerminal(h, run),
      // A runless (detached) child still has to notify the spawner — that hook
      // is what removes an isolated child's worktree.
      onFinished: (finished) =>
        run ? run.noteFinished(finished) : this.onWorkerFinished?.(finished),
    });
    const fullSpec: ChildSpec = {
      ...spec,
      // `run.closed` settles an in-flight question when the parent's turn ends.
      // A detached child has no such turn, so its question is bounded only by
      // its own timeout.
      extraTools: [createAskOrchestratorTool(handle, run?.closed ?? new AbortController().signal)],
    };
    // Registration order matters: `start()` is synchronous and can reach a
    // terminal state before it returns, so every index the terminal path
    // touches has to be populated first. The driver takes the resolved spec
    // BEFORE the row exists — it is what the runtime builds the backend from.
    this.children.set(childId, handle);
    this.indexChild(parentConversationId, handle);
    this.childSpecs.set(childId, fullSpec);
    run?.adopt(handle);
    this.driver.prepareChild(fullSpec);
    handle.start();
    return handle;
  }

  /**
   * `send_message` (design §5.2). One message, two outcomes, both returning
   * immediately:
   *
   * - the child is RUNNING → the message is queued and delivered as its next
   *   turn once the current one finishes (`mode: 'queued'`);
   * - the child is FINISHED → it is resumed right now, with the message as a
   *   new turn on its own conversation (`mode: 'resumed'`).
   *
   * Throws with actionable text rather than returning `ok: false` for the three
   * refusals a model can act on: an unknown target, a one-shot type (Explore /
   * Plan are not resumable by construction), and the steer cap — which counts
   * across resumes, or resuming would be a way to buy more steers.
   */
  sendToChild(
    parentConversationId: string,
    nameOrId: string,
    message: string,
  ): { ok: boolean; status: WorkerStatus; mode: 'queued' | 'resumed' } {
    const target = this.findChild(parentConversationId, nameOrId);
    if (!target) {
      throw new Error(`No agent named or with id "${nameOrId}" in this conversation.`);
    }
    if (target.oneShot) {
      throw new Error(
        `Agent "${nameOrId}" is a one-shot ${target.subagentType} agent and cannot be resumed.`,
      );
    }
    const handle = this.children.get(target.subagentId);
    if (handle && !TERMINAL_STATUSES.has(handle.status)) {
      const res = handle.send(message);
      if (!res.ok) {
        throw new Error(`could not deliver to ${nameOrId}: ${res.reason ?? 'unknown'}`);
      }
      return { ok: true, status: handle.status, mode: 'queued' };
    }
    return { ok: true, status: this.resumeChild(target, handle, message).status, mode: 'resumed' };
  }

  /**
   * Start a new turn on a FINISHED child's own conversation. The child keeps
   * its identity, its transcript and its grant; what it gets is a fresh handle
   * over the same conversation (design §5.2, §7.1).
   *
   * The spec comes from memory when this process still holds one and is
   * REBUILT from the persisted row otherwise — a child that finished, was
   * LRU-evicted, or belongs to a previous gateway process has no in-memory
   * spec, and refusing those was only ever a placeholder for this path. The
   * rebuild re-intersects the stored grant against what the parent holds NOW
   * (see the gateway's `reconstructChildSpec`), so a resume can never widen a
   * child past its parent.
   */
  private resumeChild(
    target: ChildSnapshot,
    prior: ChildHandle | undefined,
    message: string,
  ): ChildHandle {
    const id = target.subagentId;
    // Reconstruction FIRST, even when a spec is still in memory: it is the path
    // that re-intersects the child's grant against what its parent holds NOW,
    // and a resume is a new turn that must not run on a stale grant.
    const spec = this.reconstructChildSpec?.(id) ?? this.childSpecs.get(id);
    if (!spec) {
      throw new Error(
        `Agent "${target.name ?? id}" cannot be resumed: its grant cannot be rebuilt.`,
      );
    }
    const turn = this.live.get(key(spec.agentId, spec.parentConversationId));
    const caps =
      turn && !turn.finalized ? turn.caps : this.mergeCaps(this.resolveCaps?.(spec.agentId));
    const steersUsed = prior?.steersUsed ?? 0;
    if (steersUsed >= caps.maxSteersPerWorker) {
      throw new Error(
        `steer cap reached for "${target.name ?? id}" (max ${caps.maxSteersPerWorker} per agent).`,
      );
    }
    // A resume starts a child running, so it counts against the same ceilings a
    // spawn does.
    if (this.activeChildCount(spec.parentConversationId) >= caps.maxConcurrentWorkers) {
      throw new Error(
        `too many workers running at once (max ${caps.maxConcurrentWorkers}) — wait for workers to finish`,
      );
    }
    if (this.activeWorkerCount() >= this.globalMax) {
      throw new Error(
        `the gateway is at its global worker limit (${this.globalMax}) — wait for workers to finish`,
      );
    }
    const run = turn && !turn.finalized ? this.ensureRun(turn) : undefined;
    // The prior handle is replaced, not kept alongside: `indexChild` would
    // otherwise leave two entries for one child in the per-parent index.
    if (prior) this.forgetChild(spec.parentConversationId, id);
    const handle = this.startChild(
      { ...spec, runId: run?.runId ?? spec.runId },
      caps,
      run,
      // The resume message IS a steer, and the count carries over from the
      // handle it replaces so the cap spans a child's whole life.
      { resumeWith: message, steersUsed: steersUsed + 1 },
    );
    if (run) this.onRunChanged?.(spec.agentId, run.runId);
    return handle;
  }

  /**
   * The legacy `spawn_worker` facade. Identical lifetime to `spawnChild` — the
   * legacy tools do NOT get a second kind of child — with the parent context
   * read off the live attachment, and `p.depth` interpreted as the CHILD's
   * depth (the shape the `agent` tool has always passed).
   */
  spawnWorker(
    agentId: string,
    conversationId: string,
    p: ChildSpawnRequest & {
      /** 1 (the default) for a direct child; the `agent` tool passes childDepth. */
      depth?: number;
    },
  ): { workerId: string; status: 'spawning' } {
    const turn = this.live.get(key(agentId, conversationId));
    if (!turn || turn.finalized) {
      throw new Error('swarm turn is closed — cannot spawn');
    }
    const { depth: childDepth, ...request } = p;
    const { subagentId } = this.spawnChild(
      {
        agentId,
        agentName: turn.opts.agentName,
        conversationId,
        // The parent turn id. `messageId` is the WS message that opened the
        // turn; without one (a non-chat caller) the run id hint identifies it.
        turnId: turn.opts.messageId ?? turn.runIdHint,
        depth: (childDepth ?? 1) - 1,
        workspace: turn.opts.workspace,
      },
      request,
    );
    return { workerId: subagentId, status: 'spawning' };
  }

  async waitWorkers(
    agentId: string,
    conversationId: string,
    p: {
      workerIds?: string[];
      timeoutSeconds?: number;
      /**
       * Internal. `wait_workers` (the tool) returns as soon as any referenced
       * worker asks a question, so the orchestrator can answer it. `waitWorker`
       * waits on ONE child and passes false: a question from that child must not
       * end the wait, or the caller would see a non-terminal snapshot.
       */
      returnOnWaitingInput?: boolean;
    },
    signal?: AbortSignal,
  ): Promise<
    Array<{ workerId: string; status: WorkerStatus; report?: string; question?: string }>
  > {
    const turn = this.live.get(key(agentId, conversationId));
    const run = turn?.run;

    /**
     * The children this call is waiting on: this turn's run, plus — for ids the
     * caller NAMED — the cross-turn registry. A detached background child is
     * not in the current run, and answering `[]` ("nothing to wait for") for
     * one is the single answer that is wrong: it is the same child `findChild`
     * and `checkWorkers` resolve.
     *
     * SCOPED to this conversation, like those two are (they read
     * `childrenOf(conversationId)`): an id is a `sub_<ulid>` a model can
     * repeat, and a caller must not be able to read another conversation's
     * child report by naming it.
     */
    const referenced = (): Array<{
      workerId: string;
      role: string;
      status: WorkerStatus;
      report?: string;
      question?: string;
    }> => {
      const fromRun = run ? run.workerStatuses() : [];
      if (!p.workerIds || p.workerIds.length === 0) return fromRun;
      const wanted = new Set(p.workerIds);
      const out = fromRun.filter((w) => wanted.has(w.workerId));
      const seen = new Set(out.map((w) => w.workerId));
      for (const id of p.workerIds) {
        if (seen.has(id)) continue;
        const handle = this.children.get(id);
        const snapshot =
          handle?.parentConversationId === conversationId
            ? handle.snapshot()
            : this.childrenOf(conversationId).find((c) => c.subagentId === id);
        if (!snapshot) continue;
        out.push({
          workerId: snapshot.subagentId,
          role: snapshot.role,
          status: snapshot.status,
          report: snapshot.report,
          question: snapshot.question,
        });
      }
      return out;
    };

    const returnOnWaitingInput = p.returnOnWaitingInput ?? true;

    const settled = (): boolean => {
      const refs = referenced();
      if (refs.length === 0) return true;
      if (refs.every((w) => TERMINAL_STATUSES.has(w.status))) return true;
      if (returnOnWaitingInput && refs.some((w) => w.status === 'waiting_input')) return true;
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

      // A turn with no run of its own can still be waiting on a detached child
      // from an earlier one; there is simply no run close to settle it early.
      run?.closed.addEventListener('abort', onClosed, { once: true });
      if (signal) signal.addEventListener('abort', onAbort, { once: true });

      // If already aborted (race), settle immediately.
      if (run?.closed.aborted) onClosed();
      else if (signal?.aborted) onAbort();

      function cleanup() {
        clearInterval(poll);
        clearTimeout(timer);
        run?.closed.removeEventListener('abort', onClosed);
        if (signal) signal.removeEventListener('abort', onAbort);
      }
    });
  }

  /**
   * Wait for ONE named child to reach a terminal status and return its full
   * snapshot. Unlike `wait_workers` it does not return early when the child
   * asks a question — the question is answered out of band (sendToWorker) and
   * the wait continues. Throws when the child cannot be resolved at all.
   *
   * Resolved from the CROSS-TURN registry first, exactly like `findChild` and
   * `checkWorkers`: a child spawned in an earlier turn is addressable in this
   * one, and a background child now outlives its turn by design — throwing
   * `unknown worker` for it while the other two answered was a disagreement
   * waiting to bite.
   */
  async waitWorker(
    agentId: string,
    conversationId: string,
    workerId: string,
    signal?: AbortSignal,
  ): Promise<ChildSnapshot> {
    // Scoped to the conversation, like `findChild` / `checkWorkers`: an id
    // belonging to a DIFFERENT conversation's child is not this caller's to
    // read, however addressable it is in this process.
    const handle = this.children.get(workerId);
    if (handle?.parentConversationId === conversationId) {
      if (!TERMINAL_STATUSES.has(handle.status)) {
        // A FOREGROUND child belongs to the turn, so a closing run settles the
        // wait with whatever snapshot it has (the run cancels it a moment later
        // anyway). A BACKGROUND child is detached: the end of the turn says
        // nothing about it, so only its own terminal transition ends the wait.
        const run = handle.background ? undefined : this.getLiveRun(agentId, conversationId);
        await this.raceChildTerminal(handle, run, signal);
      }
      return handle.snapshot();
    }
    const [w] = await this.waitWorkers(
      agentId,
      conversationId,
      {
        workerIds: [workerId],
        timeoutSeconds: WAIT_WORKER_TIMEOUT_SECONDS,
        returnOnWaitingInput: false,
      },
      signal,
    );
    const snapshot = () =>
      this.workersFor(agentId, conversationId).find((s) => s.workerId === workerId);
    if (!w) {
      // No live run referenced the worker. It may still be terminal in this
      // conversation's most recent finalized run — the same view findWorker
      // returns — so agree with findWorker instead of throwing.
      const historic = snapshot();
      if (historic && TERMINAL_STATUSES.has(historic.status)) return historic;
      throw new Error(`unknown worker ${workerId}`);
    }
    if (!TERMINAL_STATUSES.has(w.status)) {
      // The wait settled without a terminal status: either the wall-clock
      // timeout (retry) or a closed run. NEVER retry on a closed run: `closed`
      // resolves waitWorkers synchronously, so the retry would re-enter on a
      // microtask forever and starve the event loop. A closed run also cannot
      // produce another transition, so the current snapshot is final.
      const run = this.getLiveRun(agentId, conversationId);
      if (run && !run.closed.aborted) {
        return this.waitWorker(agentId, conversationId, workerId, signal);
      }
    }
    const current = snapshot();
    if (!current) throw new Error(`unknown worker ${workerId}`);
    return current;
  }

  /**
   * The child's terminal transition, the run closing, or an abort — whichever
   * comes first. Rejects only on abort; a closed run is a normal settlement.
   */
  private raceChildTerminal(
    handle: ChildHandle,
    run: SwarmRun | undefined,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) return Promise.reject(new Error('aborted'));
    if (run?.closed.aborted) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        cleanup();
        reject(new Error('aborted'));
      };
      const onClosed = () => {
        cleanup();
        resolve();
      };
      const cleanup = () => {
        signal?.removeEventListener('abort', onAbort);
        run?.closed.removeEventListener('abort', onClosed);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      run?.closed.addEventListener('abort', onClosed, { once: true });
      void handle.terminalPromise.then(() => {
        cleanup();
        resolve();
      });
    });
  }

  /**
   * Wait for one child to reach a terminal state and return its snapshot.
   * Resolves immediately for a child that is already terminal.
   *
   * Unlike `wait_workers` it does not return early on a question: the question
   * is answered out of band and the wait continues.
   */
  async waitChild(subagentId: string, signal?: AbortSignal): Promise<ChildSnapshot> {
    const handle = this.children.get(subagentId);
    // Only a LIVE child can be waited on. A child this process never spawned
    // (or has already evicted) is terminal by definition and is read through
    // `findChild`; there is nothing here to wait for.
    if (!handle) throw new Error(`unknown sub-agent ${subagentId}`);
    if (TERMINAL_STATUSES.has(handle.status)) return handle.snapshot();
    if (signal?.aborted) throw new Error('aborted');
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        cleanup();
        reject(new Error('aborted'));
      };
      const cleanup = () => signal?.removeEventListener('abort', onAbort);
      signal?.addEventListener('abort', onAbort, { once: true });
      void handle.terminalPromise.then(() => {
        cleanup();
        resolve();
      });
    });
    return handle.snapshot();
  }

  /**
   * Resolve a child of `parentConversationId` by name first, then by id. Names
   * are not unique — the LATEST child with that name wins, so re-using a name
   * addresses the newest one.
   *
   * Reads {@link childrenOf}, which spans EVERY turn of the conversation: a
   * child spawned in turn N stays addressable in turn N+1, which is exactly
   * what the run-scoped lookup this replaces could not do.
   */
  findChild(parentConversationId: string, nameOrId: string): ChildSnapshot | undefined {
    const children = this.childrenOf(parentConversationId);
    return (
      [...children].reverse().find((c) => c.name === nameOrId) ??
      children.find((c) => c.subagentId === nameOrId)
    );
  }

  /**
   * Every child of a conversation, in spawn order: the ones this process still
   * holds a handle for, plus the persisted rows the driver knows about (a
   * child from before a restart). A live handle always wins over its row.
   */
  childrenOf(parentConversationId: string): ChildSnapshot[] {
    const live = this.childrenByParent.get(parentConversationId) ?? [];
    const seen = new Set(live.map((h) => h.subagentId));
    const persisted = this.driver
      .listChildren(parentConversationId)
      .filter((c) => !seen.has(c.subagentId));
    // Spawn order across BOTH sources. `findChild` resolves a duplicated name
    // to the newest child, so concatenating the two lists would make the answer
    // depend on which of them a child happened to be read from.
    return [...persisted, ...live.map((h) => h.snapshot())].sort(
      (a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0),
    );
  }

  /**
   * Cancel a child and every descendant beneath it. Depth-first from the
   * leaves so a grandchild is never left running under a cancelled parent —
   * nothing would report it afterwards.
   */
  async cancelChild(subagentId: string, reason = 'cancelled'): Promise<void> {
    for (const descendant of this.childrenOf(subagentId)) {
      await this.cancelChild(descendant.subagentId, reason);
    }
    const handle = this.children.get(subagentId);
    if (!handle || TERMINAL_STATUSES.has(handle.status)) return;
    handle.cancel(reason);
    await handle.terminalPromise;
  }

  /**
   * The fully-resolved spec of a child — what its backend is built from.
   *
   * Falls back to {@link SwarmCoordinatorOptions.reconstructChildSpec} when
   * this process holds no live one, so a turn on a finished (or pre-restart)
   * child conversation runs under the CHILD's grant instead of being refused
   * or, worse, taking the top-level agent's. The rebuilt spec carries no
   * `ask_orchestrator`: nobody is waiting on the other end of a question when
   * the turn that spawned the child is long over.
   */
  childSpec(subagentId: string): ChildSpec | undefined {
    const live = this.liveChildSpec(subagentId);
    if (live) return live;
    const rebuilt = this.reconstructChildSpec?.(subagentId);
    return rebuilt ? { ...rebuilt, extraTools: [] } : undefined;
  }

  /**
   * The IN-MEMORY spec only, with no rebuild fallback. This is what a rebuilder
   * asks for when it walks up the parent chain: routing that read through
   * {@link childSpec} would re-enter the rebuild once per level and escape the
   * walk's own depth bound.
   */
  liveChildSpec(subagentId: string): ChildSpec | undefined {
    return this.childSpecs.get(subagentId);
  }

  /**
   * Resolve a child by name then id. Legacy alias of {@link findChild}; the
   * `agentId` is ignored because a conversation id already identifies exactly
   * one agent's conversation.
   */
  findWorker(
    _agentId: string,
    conversationId: string,
    nameOrId: string,
  ): ChildSnapshot | undefined {
    return this.findChild(conversationId, nameOrId);
  }

  /**
   * The conversation's children as an addressable roster (for the agent tool
   * and the delegation section). BOUNDED — every non-terminal child plus the
   * most recent {@link ROSTER_MAX_TERMINAL_CHILDREN} terminal ones, in spawn
   * order. See that constant for why the unbounded list was a regression.
   */
  rosterFor(
    _agentId: string,
    conversationId: string,
    limit = ROSTER_MAX_TERMINAL_CHILDREN,
  ): Array<{ id: string; name?: string; type: string; status: WorkerStatus }> {
    const children = this.childrenOf(conversationId);
    const terminal = children.filter((c) => TERMINAL_STATUSES.has(c.status));
    const keep = new Set(terminal.slice(Math.max(0, terminal.length - limit)));
    return children
      .filter((c) => !TERMINAL_STATUSES.has(c.status) || keep.has(c))
      .map((c) => ({
        id: c.subagentId,
        name: c.name,
        type: c.subagentType,
        status: c.status,
      }));
  }

  sendToWorker(
    _agentId: string,
    _conversationId: string,
    p: { workerId: string; message: string },
  ): { ok: boolean; status: WorkerStatus } {
    // Resolved from the CHILD REGISTRY rather than the live run: a child is
    // addressable for as long as this process holds it, not just during the
    // turn it was spawned in.
    const handle = this.children.get(p.workerId);
    if (!handle) return { ok: false, status: 'cancelled' };
    const res = handle.send(p.message);
    return { ok: res.ok, status: handle.status };
  }

  checkWorkers(
    _agentId: string,
    conversationId: string,
  ): Array<{ workerId: string; role: string; status: WorkerStatus; detail?: string }> {
    return this.childrenOf(conversationId).map((c) => ({
      workerId: c.subagentId,
      role: c.role,
      status: c.status,
      detail: c.report ?? c.question,
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

  /**
   * Push an externally-reconstructed finalized run snapshot into the panel
   * history ring buffer. Used at gateway boot to surface runs a previous
   * process died in the middle of (rebuilt from the durable event log) —
   * without it a crash-interrupted run vanishes from the panel entirely.
   * Never touches live-turn state.
   */
  restoreFinalizedRun(snapshot: RunSnapshot): void {
    this.pushHistory(snapshot.agentId, snapshot);
  }

  /** Non-terminal children across the whole gateway (the global ceiling). */
  activeWorkerCount(): number {
    let n = 0;
    for (const handle of this.children.values()) {
      if (!TERMINAL_STATUSES.has(handle.status)) n++;
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
      onWorkerFinished: (spec) => this.onWorkerFinished?.(spec),
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

  /**
   * DEFENCE IN DEPTH on the built-in grant. `resolveChildTools` already
   * computed an intersection with the parent's tools for `agent` spawns, but
   * the legacy `spawn_worker` tool reaches this method directly with a list the
   * model chose, so the subset check has to live here too.
   *
   * The bound is `parentBuiltinTools(orchestratorTools)` — literally the same
   * function the `agent` tool builds its `ParentToolContext` from, so the two
   * cannot drift. That admits `load_skill` and the task tool (every agent has
   * them whatever `config.tools` says) and excludes skill-management and MCP-
   * management tools (parent-only, never inheritable).
   *
   * MCP names are NOT rejected as a class any more — they travel in their own
   * `mcpTools` field and are checked by {@link validateMcpTools}.
   */
  private validateTools(turn: LiveTurn, requested?: string[]): string[] {
    const allowed = new Set(parentBuiltinTools(turn.opts.orchestratorTools));
    // OMITTED (legacy `spawn_worker` leaves `tools` out) is not the same as an
    // EMPTY list. Omitted means "the read-only default" — but bounded by what
    // the orchestrator itself holds, or a parent configured `tools: ['bash']`
    // would spawn children holding read/grep/find/ls that it lacks. An empty
    // list is a resolved grant of zero built-ins (an MCP-only or spawn-only
    // definition) and MUST stay empty: widening it here would hand the child
    // tools the roster never advertised.
    if (requested === undefined) {
      return DEFAULT_WORKER_TOOLS.filter((t) => allowed.has(t));
    }
    for (const tool of requested) {
      // Redundant with the allow-list below (no `*_skill` but `load_skill` is
      // in it), kept explicit so widening the universe cannot hand a child the
      // skill-management tools by accident.
      if (tool !== 'load_skill' && /_skill$/.test(tool)) {
        throw new Error(`tool "${tool}" is not available to swarm workers`);
      }
      if (!allowed.has(tool)) {
        if (!UNIVERSE_SET.has(tool) && !ALWAYS_AVAILABLE_SET.has(tool)) {
          throw new Error(`tool "${tool}" is not available to swarm workers`);
        }
        throw new Error(
          `tool "${tool}" is not available to swarm workers (the orchestrator does not have it)`,
        );
      }
    }
    return [...requested];
  }

  /**
   * DEFENCE IN DEPTH on the MCP grant: every requested `server__tool` must be
   * one the orchestrator itself holds. An attachment that declared no MCP tools
   * grants none — a spawn asking for any is refused rather than waved through.
   */
  private validateMcpTools(turn: LiveTurn, requested?: string[]): string[] | undefined {
    if (!requested || requested.length === 0) return undefined;
    const allowed = new Set(turn.opts.orchestratorMcpTools ?? []);
    for (const tool of requested) {
      if (!allowed.has(tool)) {
        throw new Error(
          `MCP tool "${tool}" is not available to swarm workers (the orchestrator does not have it)`,
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
    return TERMINAL_STATUSES.has(status);
  }

  /**
   * Emit the terminal pair for a worker whose `worker_spawned` card reached the
   * stream but whose registration failed. Mirrors ChildHandle's ordering:
   * legacy `worker_done` first, then `subagent_finished`.
   */
  private terminalizePhantom(
    run: SwarmRun,
    workerId: string,
    p: { role: string; name?: string; subagentType?: string; description?: string },
    err: unknown,
  ): void {
    const report = err instanceof Error ? err.message : String(err);
    const nowIso = new Date().toISOString();
    const usage = { inputTokens: 0, outputTokens: 0 };
    run.channel.push({
      type: 'worker_done',
      workerId,
      runId: run.runId,
      role: p.role,
      status: 'failed',
      report,
      usage,
    });
    run.channel.push({
      type: 'subagent_finished',
      subagentId: workerId,
      ...(p.name !== undefined ? { name: p.name } : {}),
      subagentType: p.subagentType ?? DEFAULT_SUBAGENT_TYPE,
      description: p.description ?? p.role,
      status: 'failed',
      report,
      usage,
      toolCallCount: 0,
      startedAt: nowIso,
      endedAt: nowIso,
    });
  }

  /**
   * The children of a conversation, as the tools see them. Kept as a private
   * alias of {@link childrenOf} so the run-scoped lookup it replaced cannot
   * creep back in: that one could see a live run OR one finalized run, never
   * both, which is what made a child from an earlier turn unaddressable.
   */
  private workersFor(_agentId: string, conversationId: string): ChildSnapshot[] {
    return this.childrenOf(conversationId);
  }

  /**
   * Push onto a parent's live event channel, or drop it when the parent has no
   * live turn — a background child outlives the turn that spawned it and must
   * not write into a channel nobody is reading.
   *
   * Deliberately NOT gated on `turn.finalized`: `finalizeTurn` flips that flag
   * before it cancels the turn's children, and their `worker_done{cancelled}`
   * has to reach the channel before it closes. The map delete at the end of
   * `finalizeTurn` is the real boundary; `AsyncChannel.push` is already a
   * no-op once closed.
   */
  private emitToParent(agentId: string, conversationId: string, event: AgentEvent): void {
    const turn = this.live.get(key(agentId, conversationId));
    if (!turn) return;
    const channel = turn.run?.channel ?? turn.preRunChannel;
    channel.push(event);
  }

  /** Non-terminal children of ONE conversation (the per-conversation cap). */
  private activeChildCount(conversationId: string): number {
    let n = 0;
    for (const handle of this.childrenByParent.get(conversationId) ?? []) {
      if (!TERMINAL_STATUSES.has(handle.status)) n++;
    }
    return n;
  }

  /**
   * Append to the per-parent index, evicting the oldest TERMINAL children past
   * the retention bound. Live children are never evicted — the index is what
   * the caps count and what a cancel cascade walks.
   */
  private indexChild(parentConversationId: string, handle: ChildHandle): void {
    const list = this.childrenByParent.get(parentConversationId) ?? [];
    list.push(handle);
    while (list.length > MAX_RETAINED_CHILDREN_PER_PARENT) {
      const index = list.findIndex((h) => TERMINAL_STATUSES.has(h.status));
      if (index < 0) break;
      const [evicted] = list.splice(index, 1);
      this.children.delete(evicted.subagentId);
      this.childSpecs.delete(evicted.subagentId);
    }
    // Delete-then-set moves the key to the BACK of the map's insertion order,
    // which is what makes `evictColdParents` a recency eviction rather than a
    // first-conversation-ever eviction.
    this.childrenByParent.delete(parentConversationId);
    this.childrenByParent.set(parentConversationId, list);
    this.evictColdParents();
  }

  /** Drop every trace of a child whose registration failed. */
  private forgetChild(parentConversationId: string, subagentId: string, run?: SwarmRun): void {
    this.children.delete(subagentId);
    this.childSpecs.delete(subagentId);
    // `adopt` already put it in the run; leaving it there gives the phantom a
    // second `worker_done` from the run's cancel sweep and a row in every
    // snapshot of a child that never started.
    run?.forget(subagentId);
    const list = this.childrenByParent.get(parentConversationId);
    if (!list) return;
    const index = list.findIndex((h) => h.subagentId === subagentId);
    if (index >= 0) list.splice(index, 1);
  }

  /**
   * Drop the in-memory registry of a conversation's children — used when the
   * conversation is deleted (the delete cascades to the children's own rows,
   * so nothing is left to address) and by the cross-conversation LRU below.
   *
   * Recurses: a child's conversation can itself be a parent, and the delete
   * cascaded to those rows too.
   *
   * CANCELS a live descendant on the way out. A background child is detached
   * from the turn that spawned it, so deleting its parent mid-turn used to drop
   * the handle while the child kept running: under-counting the global ceiling
   * and leaving `findChild` / `cancelChild` / `sendToChild` unable to reach the
   * thing still burning tokens. The cancel is synchronous (`ChildHandle.cancel`
   * never awaits the driver), so the registry is consistent when this returns.
   * The LRU sweep only calls this for buckets with no live descendant, so it
   * never cancels anything.
   */
  forgetConversation(conversationId: string): void {
    const handles = this.childrenByParent.get(conversationId);
    if (!handles) return;
    this.childrenByParent.delete(conversationId);
    for (const handle of handles) {
      // Depth-first: a grandchild is cancelled before the child above it, so
      // nothing is ever left running under a cancelled parent.
      this.forgetConversation(handle.subagentId);
      if (!TERMINAL_STATUSES.has(handle.status)) {
        handle.cancel('the conversation was deleted');
      }
      this.children.delete(handle.subagentId);
      this.childSpecs.delete(handle.subagentId);
    }
  }

  /**
   * Evict the least-recently-spawned parent buckets past
   * {@link MAX_TRACKED_PARENT_CONVERSATIONS}. A bucket holding ANY non-terminal
   * child is skipped, whatever its age: the caps count those handles and a
   * cancel cascade walks them, so dropping one would lose a live child.
   */
  private evictColdParents(): void {
    if (this.childrenByParent.size <= MAX_TRACKED_PARENT_CONVERSATIONS) return;
    // Map iteration is insertion order, and `indexChild` re-inserts on every
    // spawn, so the front of this list is the least recently active parent.
    for (const [parent] of [...this.childrenByParent]) {
      if (this.childrenByParent.size <= MAX_TRACKED_PARENT_CONVERSATIONS) return;
      if (this.hasLiveDescendant(parent)) continue;
      this.forgetConversation(parent);
    }
  }

  /**
   * Any non-terminal child ANYWHERE beneath this conversation. The check is
   * recursive because `forgetConversation` is: a terminal child can still have
   * a background grandchild running under it, and evicting the bucket would
   * drop that grandchild from the global registry — under-counting the caps
   * and leaving nothing for a cancel cascade to find.
   */
  private hasLiveDescendant(conversationId: string): boolean {
    for (const handle of this.childrenByParent.get(conversationId) ?? []) {
      if (!TERMINAL_STATUSES.has(handle.status)) return true;
      if (this.hasLiveDescendant(handle.subagentId)) return true;
    }
    return false;
  }

  /**
   * One child's terminal transition: tell the run (when it still has one), then
   * release the runtime. Dropping the resolved spec here is what makes a later
   * resume go through `reconstructChildSpec` — the durable record is the row.
   */
  private onChildTerminal(handle: ChildHandle, run?: SwarmRun): void {
    this.childSpecs.delete(handle.subagentId);
    try {
      this.driver.releaseChild?.(handle.subagentId);
    } catch {
      // A runtime that cannot release a finished child must not break its
      // terminal transition — the child is over either way.
    }

    // Enqueue notifications for background and resumed children (design §7.3, ruling 1).
    // Durable first: enqueue before attempting delivery.
    if (handle.background || handle.resumed) {
      this.enqueueChildNotification(handle);
    }

    run?.noteTerminal();
  }

  /**
   * Enqueue a notification for a terminal background or resumed child
   * (design §7.3, ruling 1). Durable first: enqueue before attempting delivery,
   * so a crash between the two loses nothing. Then try to deliver immediately.
   */
  private enqueueChildNotification(handle: ChildHandle): void {
    if (!this.notifications) return;

    try {
      const payload: Record<string, unknown> = {
        subagentId: handle.subagentId,
        name: handle.name,
        subagentType: handle.subagentType,
        description: handle.description,
        status: handle.status,
        report: handle.report,
        toolCallCount: handle.toolCallCount,
        startedAt: handle.startedAtIso ?? new Date().toISOString(),
        endedAt: handle.endedAtIso ?? new Date().toISOString(),
      };
      if (handle.usage) {
        payload.usage = handle.usage;
      }

      this.notifications.enqueue({
        conversationId: handle.parentConversationId,
        kind: 'subagent_finished',
        payload,
      });
    } catch (err) {
      // Enqueue failure doesn't break the child's terminal transition.
      this.notifications?.warn(`Failed to enqueue notification: ${String(err)}`);
      return;
    }

    // Try to deliver immediately (ruling 2: decide via acceptTurn, not pre-check).
    // Fire-and-forget; failures are bounded.
    void this.deliverPending(handle.agentId, handle.parentConversationId).catch(() => {});
  }

  /**
   * Deliver pending notifications for a parent conversation.
   * Called on parent's finishTurn (design §7.3, ruling 3).
   * Coalesces all pending notifications into one turn (ruling 4).
   */
  async deliverPending(agentId: string, conversationId: string): Promise<DeliveryOutcome> {
    const notifications = this.notifications;
    if (!notifications) return 'nothing';

    // Deliberately NO in-flight guard. This body contains no `await` between
    // the peek and the ack, so it cannot interleave with itself, and a guard
    // that is only cleared on some return paths turns the FIRST successful
    // delivery on a conversation into its last.
    const items = notifications.peek(conversationId);
    if (items.length === 0) return 'nothing';

    // Every pending row rides ONE turn, in creation order (ruling 4).
    const text = composeNotificationText(items);
    const events = notificationInitialEvents(items);
    const turnId = randomUUID();
    if (events.length > 0) this.rememberNotificationEvents(turnId, events);

    try {
      // Ruling 2: `acceptTurn` decides idle vs busy — there is no pre-check.
      const result = notifications.startNotificationTurn(agentId, conversationId, text, turnId);
      // A driver that mints its own id still has to find its events.
      if (result.turnId !== turnId) {
        const pending = this.notificationEvents.get(turnId);
        this.notificationEvents.delete(turnId);
        if (pending) this.rememberNotificationEvents(result.turnId, pending);
      }
      // The turn is accepted and persisted, so the rows have been delivered.
      // Acking AFTER the start means a crash in between redelivers rather than
      // loses — the safe direction.
      notifications.ack(items.map((item) => item.id));
      return 'started';
    } catch (err) {
      this.notificationEvents.delete(turnId);
      if (err instanceof ChildTurnStartError) {
        // Busy or stopped: the rows were never removed, so there is nothing to
        // restore — the next finishTurn picks them up unchanged (ruling 2).
        if (err.reason === 'busy' || err.reason === 'stopped') return 'nothing';
        // The parent is gone. Bounded failure: warn once and drop (ruling 8).
        if (err.reason === 'error') {
          notifications.warn(err.message);
          try {
            notifications.ack(items.map((item) => item.id));
          } catch (ackErr) {
            notifications.warn(`Failed to drop notifications: ${String(ackErr)}`);
          }
          return 'nothing';
        }
      }
      // Anything else is unclassified: leave the rows queued and report it.
      notifications.warn(`Failed to deliver notifications: ${String(err)}`);
      return 'error';
    }
  }

  /** Records a notification turn's initial events, evicting the oldest first. */
  private rememberNotificationEvents(turnId: string, events: AgentEvent[]): void {
    this.notificationEvents.set(turnId, events);
    while (this.notificationEvents.size > MAX_PENDING_NOTIFICATION_EVENTS) {
      const oldest = this.notificationEvents.keys().next();
      if (oldest.done) break;
      this.notificationEvents.delete(oldest.value);
    }
  }

  /**
   * Retrieve and clear the initial events for a notification turn.
   * Called by the gateway's merge wrapper to inject subagent_finished events
   * onto the parent log before orchestrator output (design §7.3, ruling 5).
   */
  takeInitialEvents(turnId: string): AgentEvent[] | undefined {
    const events = this.notificationEvents.get(turnId);
    this.notificationEvents.delete(turnId);
    return events;
  }

  /**
   * Queue a message from a child to be delivered to the parent conversation.
   * The message is scanned and enqueued as a subagent_message notification.
   */
  notifyMain(childId: string, message: string): void {
    if (!this.notifications) return;

    const handle = this.children.get(childId);
    if (!handle) return;

    try {
      this.notifications.enqueue({
        conversationId: handle.parentConversationId,
        kind: 'subagent_message',
        payload: {
          from: handle.name ?? childId,
          message,
        },
      });
    } catch (err) {
      this.notifications?.warn(`Failed to enqueue subagent_message: ${String(err)}`);
      return;
    }

    // Try to deliver immediately (ruling 2).
    // Fire-and-forget; failures are bounded.
    void this.deliverPending(handle.agentId, handle.parentConversationId).catch(() => {});
  }

  private pushHistory(agentId: string, snap: RunSnapshot): void {
    const list = this.history.get(agentId) ?? [];
    list.push(snap);
    while (list.length > RING_BUFFER_SIZE) list.shift();
    this.history.set(agentId, list);
  }
}
