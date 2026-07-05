import type { AgentEvent } from '@dash/agent';

/** One conversational segment of a worker. Duck-typed over DashAgent.chat. */
export interface WorkerBackend {
  chat(message: string): AsyncGenerator<AgentEvent>;
  abort(): void;
  stop(): Promise<void>;
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
  /** Worker-side extra tools (ask_orchestrator) built by the coordinator. */
  extraTools: SwarmExtraTool[];
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
  | 'cancelled';

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
