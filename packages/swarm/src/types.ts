import type { AgentEvent } from '@dash/agent';

/** One conversational segment of a worker. Duck-typed over DashAgent.chat. */
export interface WorkerBackend {
  chat(message: string): AsyncGenerator<AgentEvent>;
  abort(): void;
  stop(): Promise<void>;
  /**
   * The directory the child ACTUALLY runs in. Normally the parent's workspace,
   * but an `isolation: 'worktree'` child runs in its own checkout, whose path
   * only the factory knows. Reported in the worker snapshot so the `agent`
   * tool's details can tell a user where the child worked.
   */
  workspace?: string;
}

export interface WorkerSpec {
  agentId: string; // registry id (run keying)
  agentName: string; // config.name (session dir)
  runId: string;
  workerId: string;
  role: string;
  brief: string;
  model: string;
  workspace: string;
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

export type WorkerFactory = (spec: WorkerSpec) => Promise<WorkerBackend>;

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
  maxRunSeconds: number; // 1800
}

export interface SwarmEventLogSink {
  append(
    agentId: string,
    conversationId: string,
    messageId: string,
    payload: { type: 'event'; event: AgentEvent },
  ): Promise<unknown>;
}
