import type { SwarmCoordinator } from './coordinator.js';
import type { SwarmExtraTool, WorkerStatus } from './types.js';
import type { WorkerHandle } from './worker-handle.js';

/**
 * The swarm tools are the LLM-facing surface of a swarm run. The orchestrator
 * gets four tools (spawn/wait/send/check) injected via PiAgentBackend's
 * extraTools; each spawned worker gets one (ask_orchestrator) built per-worker.
 *
 * `parameters` are plain JSON-schema objects — the exact runtime shape TypeBox
 * emits (see @dash/projects tools). They stay plain objects here so @dash/swarm
 * carries no TypeBox dependency; the pi runtime duck-types them either way.
 *
 * Error discipline mirrors the projects tools: expected failures THROW an Error
 * with actionable text (pi converts a thrown error into an isError result). The
 * coordinator already throws Errors for closed turns / caps / validation, so
 * spawn simply lets those propagate.
 */

const SPAWN_WORKER_PARAMETERS = {
  type: 'object',
  properties: {
    role: {
      type: 'string',
      description:
        'Short role/name for this worker (e.g. "researcher", "test-writer"). Appears in the panel and status events.',
    },
    brief: {
      type: 'string',
      description:
        'A self-contained brief: everything the worker needs to do its part without seeing this conversation. State the goal, the relevant files/paths, and exactly what to report back.',
    },
    tools: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Optional subset of tool names to grant the worker (e.g. ["read","grep","bash"]). Must be tools you (the orchestrator) already have. Defaults to read-only tools.',
    },
    model: {
      type: 'string',
      description:
        'Optional model id for the worker. Must be an allowed model; defaults to your own model.',
    },
  },
  required: ['role', 'brief'],
  additionalProperties: false,
} as const;

const WAIT_WORKERS_PARAMETERS = {
  type: 'object',
  properties: {
    workerIds: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Optional list of worker ids to wait on. Omit to wait on all workers in this run.',
    },
    timeoutSeconds: {
      type: 'number',
      description:
        'Optional max seconds to block before returning the current status. Defaults to 300.',
    },
  },
  additionalProperties: false,
} as const;

const SEND_TO_WORKER_PARAMETERS = {
  type: 'object',
  properties: {
    workerId: {
      type: 'string',
      description: 'The id of the worker to steer or answer (from spawn_worker / check_workers).',
    },
    message: {
      type: 'string',
      description:
        'The steer or answer to deliver. If the worker asked a question it is answered; otherwise this is queued as an additional instruction (steer).',
    },
  },
  required: ['workerId', 'message'],
  additionalProperties: false,
} as const;

const CHECK_WORKERS_PARAMETERS = {
  type: 'object',
  properties: {},
  additionalProperties: false,
} as const;

const ASK_ORCHESTRATOR_PARAMETERS = {
  type: 'object',
  properties: {
    question: {
      type: 'string',
      description:
        'The question or blocker to send up to the orchestrator. Be specific — you are paused until it answers.',
    },
  },
  required: ['question'],
  additionalProperties: false,
} as const;

/** ask_orchestrator waits up to 10 minutes for the orchestrator to answer. */
const ASK_TIMEOUT_MS = 600_000;

export interface CreateSwarmToolsOptions {
  coordinator: SwarmCoordinator;
  agentId: string;
  /**
   * Late-bound conversation id: called per tool invocation. The gateway wires
   * this to `backend.getCurrentSessionId()` so each tool call resolves the run
   * for the conversation the orchestrator turn belongs to (like projects tools).
   */
  conversationId: () => string;
}

/** Coerce a raw params value into a shape with known optional fields. */
function asRecord(params: unknown): Record<string, unknown> {
  return (params && typeof params === 'object' ? params : {}) as Record<string, unknown>;
}

/** A compact one-line summary of a worker's current state. */
function summarizeWorker(w: {
  workerId: string;
  status: WorkerStatus;
  role?: string;
  report?: string;
  question?: string;
  detail?: string;
}): string {
  const role = w.role ? ` ${w.role}` : '';
  const extra = w.question
    ? ` — asks: ${w.question}`
    : w.report
      ? ` — ${w.report}`
      : w.detail
        ? ` — ${w.detail}`
        : '';
  return `${w.workerId}${role}: ${w.status}${extra}`;
}

/**
 * Build the orchestrator-side swarm tools over a `SwarmCoordinator`. Injected
 * into the orchestrator's PiAgentBackend via extraTools. Each tool resolves the
 * live run by `(agentId, conversationId())` on every call.
 */
export function createSwarmTools(opts: CreateSwarmToolsOptions): SwarmExtraTool[] {
  const { coordinator, agentId } = opts;
  const convo = () => opts.conversationId();

  const spawnWorker: SwarmExtraTool = {
    name: 'spawn_worker',
    label: 'Spawn Worker',
    description:
      'Spawn a parallel worker (subagent) with a role and a self-contained brief. This is step one of the swarm loop: spawn several workers (each with a distinct role and a brief that stands alone), then wait_workers to collect their reports, answer any questions or send_to_worker to steer, wait again, and finally synthesize one answer from their reports. Workers share your workspace, so tell each one exactly which files to touch. Caps limit how many run at once and per run — spawn only what you need.',
    parameters: SPAWN_WORKER_PARAMETERS,
    execute: async (_id, params) => {
      const p = asRecord(params);
      const role = typeof p.role === 'string' ? p.role : '';
      const brief = typeof p.brief === 'string' ? p.brief : '';
      if (!role) throw new Error('role is required.');
      if (!brief) throw new Error('brief is required.');
      const tools = Array.isArray(p.tools) ? (p.tools as string[]) : undefined;
      const model = typeof p.model === 'string' ? p.model : undefined;
      const { workerId, status } = coordinator.spawnWorker(agentId, convo(), {
        role,
        brief,
        tools,
        model,
      });
      const run = coordinator.getLiveRun(agentId, convo());
      return {
        content: [{ type: 'text', text: `spawned ${workerId} (${role})` }],
        details: { workerId, runId: run?.runId, status },
      };
    },
  };

  const waitWorkers: SwarmExtraTool = {
    name: 'wait_workers',
    label: 'Wait for Workers',
    description:
      "Block until the referenced workers finish or need input, then return each one's status and report. This is the collection step of the loop: after spawning, wait_workers to gather reports; a worker in waiting_input has asked a question you should answer with send_to_worker before waiting again. Respects the run wall-clock cap and returns early on timeoutSeconds. When every worker is done, synthesize a final answer from their reports.",
    parameters: WAIT_WORKERS_PARAMETERS,
    execute: async (_id, params, signal) => {
      const p = asRecord(params);
      const workerIds = Array.isArray(p.workerIds) ? (p.workerIds as string[]) : undefined;
      const timeoutSeconds = typeof p.timeoutSeconds === 'number' ? p.timeoutSeconds : undefined;
      // Pass the pi-provided signal straight through; on abort the coordinator
      // rejects and we let that propagate (pi turns it into an isError result).
      const workers = await coordinator.waitWorkers(
        agentId,
        convo(),
        { workerIds, timeoutSeconds },
        signal,
      );
      const text = workers.length
        ? workers.map((w) => summarizeWorker(w)).join('\n')
        : 'no workers to wait on';
      return {
        content: [{ type: 'text', text }],
        details: { workers },
      };
    },
  };

  const sendToWorker: SwarmExtraTool = {
    name: 'send_to_worker',
    label: 'Send to Worker',
    description:
      'Answer a worker that is waiting on you, or steer a running worker with an additional instruction. Use this between wait_workers calls to unblock or redirect a worker, then wait again. Steers are capped per worker; a worker that has already finished cannot be steered.',
    parameters: SEND_TO_WORKER_PARAMETERS,
    execute: async (_id, params) => {
      const p = asRecord(params);
      const workerId = typeof p.workerId === 'string' ? p.workerId : '';
      const message = typeof p.message === 'string' ? p.message : '';
      if (!workerId) throw new Error('workerId is required.');
      if (!message) throw new Error('message is required.');
      const { ok, status } = coordinator.sendToWorker(agentId, convo(), { workerId, message });
      const text = ok
        ? `delivered to ${workerId} (${status})`
        : `could not deliver to ${workerId} (${status})`;
      return {
        content: [{ type: 'text', text }],
        details: { ok, status, workerId },
      };
    },
  };

  const checkWorkers: SwarmExtraTool = {
    name: 'check_workers',
    label: 'Check Workers',
    description:
      'Return a non-blocking snapshot of every worker in this run — id, role, status, and its latest report or question. Use this to poll progress without blocking (unlike wait_workers) so you can decide whether to steer, spawn more, or wait. Returns an empty roster before you have spawned anything.',
    parameters: CHECK_WORKERS_PARAMETERS,
    execute: async () => {
      const workers = coordinator.checkWorkers(agentId, convo());
      const text = workers.length
        ? workers.map((w) => summarizeWorker(w)).join('\n')
        : 'no workers in this run';
      return {
        content: [{ type: 'text', text }],
        details: { workers },
      };
    },
  };

  return [spawnWorker, waitWorkers, sendToWorker, checkWorkers];
}

/**
 * Build the worker-side `ask_orchestrator` tool. Passed to a worker via
 * WorkerSpec.extraTools by the coordinator. Calling it pauses the worker
 * (worker_status{waiting_input}) until the orchestrator answers (send_to_worker),
 * the run closes, the pi signal aborts, or a 10-minute timeout elapses.
 *
 * `closed` is the run's `closed` signal; it is combined with pi's per-call
 * signal via AbortSignal.any so either aborts the wait. A run-closed / timeout /
 * cancel rejection propagates as a thrown Error (pi → isError result).
 */
export function createAskOrchestratorTool(
  handle: WorkerHandle,
  closed: AbortSignal,
): SwarmExtraTool {
  return {
    name: 'ask_orchestrator',
    label: 'Ask Orchestrator',
    description:
      'Ask the orchestrator a question and pause until it answers. Use this when you are blocked on a decision only the orchestrator can make (ambiguous scope, a conflict, missing context). You stay paused — do not poll — until an answer comes back, the run ends, or the request times out.',
    parameters: ASK_ORCHESTRATOR_PARAMETERS,
    execute: async (_id, params, signal) => {
      const p = asRecord(params);
      const question = typeof p.question === 'string' ? p.question : '';
      if (!question) throw new Error('question is required.');
      const combined = AbortSignal.any([signal, closed].filter((s): s is AbortSignal => !!s));
      const answer = await handle.waitForQuestion(question, combined, ASK_TIMEOUT_MS);
      return {
        content: [{ type: 'text', text: answer }],
        details: { answer },
      };
    },
  };
}
