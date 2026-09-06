import type { AgentEvent } from '@dash/agent';

export interface WorkerSpec {
  agentId: string; // registry id (run keying)
  agentName: string; // config.name (session dir)
  runId: string;
  workerId: string;
  role: string;
  brief: string;
  model: string;
  /**
   * Where the child RUNS, and what its tools are sandboxed to. For an
   * `isolation: 'worktree'` child that is its own checkout — which is what a
   * RESUMED one already carries, since the path is known by then.
   */
  workspace: string;
  /**
   * The repository an `isolation: 'worktree'` checkout is cut FROM: the
   * parent's workspace. Distinct from {@link WorkerSpec.workspace} on purpose —
   * `git worktree add` runs IN the repo, and a resumed isolated child's
   * `workspace` is the checkout, not the repo. Unset on a fresh spawn, where
   * the two are the same directory.
   */
  isolationSource?: string;
  tools: string[];
  /**
   * Fully-qualified `server__tool` MCP names this child may call, resolved by
   * `resolveChildTools` against the parent's own MCP grant. Absent = no MCP.
   */
  mcpTools?: string[];
  /** `agent(a, b)` — the sub-agent types this child may spawn. Unset = all. */
  spawnableTypes?: string[];
  /** Whether this child gets `agent` / `send_message` (depth + definition). */
  canSpawn?: boolean;
  /** Worker-side extra tools (ask_orchestrator) built by the coordinator. */
  extraTools: SwarmExtraTool[];
  subagentType?: string; // defaults 'general-purpose'
  description?: string; // 3-5 words for UI
  name?: string; // addressable name
  systemPrompt?: string; // definition body (+ preloaded skills); preamble is prepended by wiring
  background?: boolean;
  isolation?: 'worktree';
  skipMemory?: boolean; // Explore/Plan
  maxTurns?: number;
  oneShot?: boolean; // Explore/Plan: not resumable
  depth?: number; // 1 for a direct child
}

/**
 * Plugin hook seam fired around a child's lifecycle. Synchronous and
 * fire-and-forget: a hook may observe (log, notify, audit) a child, never block
 * one.
 */
export interface SwarmHooks {
  subagentStart?(w: { workerId: string; role: string }): void;
  subagentStop?(w: { workerId: string; role: string; status: string }): void;
}

/** Structural copy of @dash/agent ExtraTool (types.ts:103-116) to stay duck-typed. */
export interface SwarmExtraTool {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute(
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
  ): Promise<{ content: Array<{ type: 'text'; text: string }>; details?: unknown }>;
}

export type WorkerStatus =
  | 'spawning'
  | 'running'
  | 'waiting_input'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'max_turns';

export interface SwarmCaps {
  maxConcurrentWorkers: number; // 8
  maxWorkersPerRun: number; // 24
  maxSteersPerWorker: number; // 10
  /**
   * The per-CHILD wall clock, in seconds. Per child rather than per run since
   * Task C4: a background child outlives the turn that spawned it, so a
   * run-scoped clock would either kill a detached child when its parent's turn
   * ended or never fire for it at all. The run keeps its own timer for the
   * ORCHESTRATOR's turn, bounded by the same number.
   */
  maxRunSeconds: number; // 1800
  /**
   * How deep descendants may nest. A direct child is depth 1, so `maxDepth: 3`
   * admits depths 1-3 and refuses depth 4; `maxDepth: 0` refuses every spawn.
   * The same number bounds `resolveChildTools`, which withholds `agent` /
   * `send_message` from a child that has already reached it — the ceiling is
   * enforced twice on purpose (the tool grant is advisory to the model, the
   * coordinator check is not).
   */
  maxDepth: number; // 3
}

export interface SwarmEventLogSink {
  append(
    agentId: string,
    conversationId: string,
    messageId: string,
    payload: { type: 'event'; event: AgentEvent },
  ): Promise<unknown>;
}

/**
 * The persisted half of a child, mirroring the gateway contract's
 * `SubagentInfo` structurally so `@dash/swarm` stays free of a dependency on
 * `@dash/mobile-contract`. Written into the child conversation's
 * `subagent_meta` by the {@link ChildTurnDriver}.
 */
export interface ChildInfo {
  type: string;
  name?: string;
  status: WorkerStatus;
  description: string;
  prompt: string;
  model: string;
  background: boolean;
  isolation?: 'worktree';
  depth: number;
  startedAt: string;
  endedAt?: string;
  usage?: { inputTokens: number; outputTokens: number };
  toolCallCount: number;
  report?: string;
  oneShot: boolean;
  /** Where the child ACTUALLY ran — its own worktree when it was isolated. */
  workspace?: string;
}

/** The child conversation row a spawn creates (design §7.4). */
export interface ChildConversationInput {
  /** `sub_<ulid>`; also the child's subagent id. */
  id: string;
  agentId: string;
  agentName: string;
  parentConversationId: string;
  parentTurnId: string;
  title: string;
  subagent: ChildInfo;
}

/** Identifies one turn of one child conversation. */
export interface ChildTurnRef {
  agentId: string;
  conversationId: string;
  turnId: string;
}

export type ChildTurnOutcome = 'completed' | 'cancelled' | 'failed';

/**
 * Why a child's turn could not be started. The two shapes matter: a `'busy'`
 * conversation is retryable (the lease is held by an in-flight turn) while a
 * stopped hub is not, and the gateway's `startSystemTurn` reports the second
 * as a BARE `Error` rather than a typed conversation error — a driver that
 * classified everything as busy would retry forever against a dead hub.
 */
export type ChildTurnStartReason = 'busy' | 'stopped' | 'error';

export class ChildTurnStartError extends Error {
  constructor(
    readonly reason: ChildTurnStartReason,
    message: string,
  ) {
    super(message);
    this.name = 'ChildTurnStartError';
  }
}

/**
 * The seam between the coordinator's child state machine and whatever actually
 * runs a child turn. The gateway implements it over `ResumableChatHub` +
 * `ConversationService`: a child is a real conversation, so it persists,
 * replays, and survives a restart (design §7.1, §7.4).
 */
export interface ChildTurnDriver {
  /**
   * Hands the driver the fully-resolved child spec — tools, MCP grant, system
   * prompt, extra tools, workspace — before its conversation row exists. This
   * is what the runtime builds the child's backend from: the persisted
   * `subagent_meta` carries the USER-visible half of a child, not its grant.
   */
  prepareChild(spec: ChildSpec): void;
  /** Creates the child's conversation row. Synchronous: spawns register before any await. */
  createChild(input: ChildConversationInput): void;
  /** Starts one turn on the child. Throws {@link ChildTurnStartError} when it cannot. */
  startTurn(input: {
    agentId: string;
    conversationId: string;
    text: string;
    origin: 'parent';
    /**
     * The client correlation id of the `send_message` / REST resume this turn
     * came from, echoed on the turn's `accepted` frame so the client can pair
     * it with its own optimistic row. Absent for a child's FIRST turn (nobody
     * asked for it), and for the orchestrator's own `send_message` (no client
     * row to pair with).
     */
    requestId?: string;
  }): { turnId: string };
  /** Cooperative abort of the child's live turn. Never awaited by a cancel. */
  cancelTurn(agentId: string, conversationId: string): Promise<void>;
  /** Persists a status / info patch onto the child's conversation row. */
  updateChild(id: string, patch: { status?: WorkerStatus; info?: Partial<ChildInfo> }): void;
  /**
   * The PERSISTED children of a parent conversation. This is what makes a
   * child addressable across turns: the in-memory registry only holds children
   * this process still has live handles for.
   */
  listChildren(parentConversationId: string): ChildSnapshot[];
  /**
   * False once the child's conversation row is gone. A parent delete cascades
   * to its descendants, so a live child's row can vanish mid-turn; the
   * coordinator polls this and aborts rather than streaming into nothing.
   */
  isChildAlive(childConversationId: string): boolean;
  /** Where the child ran, when the runtime knows (an isolated child's worktree). */
  workspaceOf?(childConversationId: string): string | undefined;
  onEvent(listener: (turn: ChildTurnRef, event: AgentEvent) => void): () => void;
  /**
   * `error` carries the failure text of a `'failed'` turn. Without it a child's
   * report would read "the sub-agent turn failed" instead of what went wrong,
   * which is the one line the parent actually acts on.
   */
  onFinish(
    listener: (turn: ChildTurnRef, outcome: ChildTurnOutcome, error?: string) => void,
  ): () => void;
  /**
   * The child reached a terminal state and the runtime may drop whatever it
   * holds for it (a warm backend, a pool pin). Never removes the conversation:
   * a finished child's transcript stays addressable.
   */
  releaseChild?(childConversationId: string): void;
}

/** The full spec of one child, including its own conversation identity. */
export interface ChildSpec extends WorkerSpec {
  /** `sub_<ulid>` — the child's conversation id AND its subagent id. */
  childConversationId: string;
  parentConversationId: string;
  parentTurnId: string;
}

/** A child as seen by the tools, the panel and `waitChild`. */
export interface ChildSnapshot {
  /** The child's conversation id. Legacy callers read the same value as `workerId`. */
  subagentId: string;
  workerId: string;
  parentConversationId: string;
  parentTurnId: string;
  role: string;
  status: WorkerStatus;
  brief: string;
  model: string;
  report?: string;
  question?: string;
  usage: { inputTokens: number; outputTokens: number };
  startedAt?: number;
  endedAt?: number;
  subagentType: string;
  description: string;
  name?: string;
  toolCallCount: number;
  background: boolean;
  oneShot: boolean;
  depth: number;
  workspace?: string;
}
