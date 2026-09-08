import { type CreateAgentToolsOptions, NAME_RE, createChildSpawnSeam } from './agent-tool.js';
import type { SwarmCoordinator } from './coordinator.js';
import { DEFAULT_SUBAGENT_TYPE } from './subagent-status.js';
import type { SwarmExtraTool, WorkerStatus } from './types.js';

/** The one thing `ask_orchestrator` needs from a child: its question waiter. */
export interface QuestionHost {
  waitForQuestion(
    question: string,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<string>;
}

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

/**
 * The legacy four are §5.2 FACADES over the same machinery `agent` /
 * `send_message` use, so they need everything a typed spawn needs: the
 * definition roster, the parent's grant, its model. Same options object as
 * {@link CreateAgentToolsOptions} — the gateway builds both bundles from one
 * set of inputs, which is what makes "one coordinator, shared caps" true.
 */
export type CreateSwarmToolsOptions = CreateAgentToolsOptions;

/**
 * The built-in grant `spawn_worker` has always documented ("Defaults to
 * read-only tools") and `SwarmCoordinator.validateTools` has always applied
 * when `tools` was omitted. Kept as the facade's explicit override rather than
 * inherited from the `general-purpose` definition, which has no `tools:` key
 * and therefore resolves to the parent's WHOLE grant — routing the legacy tool
 * through it unqualified would hand every legacy worker `bash`, `edit` and
 * `write` for the first time.
 */
const LEGACY_DEFAULT_TOOLS = ['read', 'grep', 'find', 'ls'] as const;

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
  const seam = opts.seam ?? createChildSpawnSeam(opts);

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
      const requested = Array.isArray(p.tools) ? (p.tools as string[]) : undefined;
      const model = typeof p.model === 'string' ? p.model : undefined;

      // §5.2: `spawn_worker` = `agent(subagent_type: general-purpose,
      // tools: <subset>, run_in_background: true)` with the role as `name` and
      // the brief as `prompt`.
      const { grant } = seam.grantFor(DEFAULT_SUBAGENT_TYPE);
      // An EXPLICIT subset goes through verbatim so the coordinator's
      // `validateTools` still refuses (with its actionable message) a tool the
      // orchestrator does not hold. The DEFAULT is filtered instead, which is
      // exactly what `validateTools` did for an omitted list.
      const tools = requested ?? LEGACY_DEFAULT_TOOLS.filter((t) => grant.tools.includes(t));

      const { workerId } = await seam.spawn({
        typeName: DEFAULT_SUBAGENT_TYPE,
        prompt: brief,
        description: role,
        role,
        // A role is free text and `name` is a strict identifier; a role that
        // cannot be one is simply not a name (the row still shows the role).
        ...(NAME_RE.test(role) ? { name: role } : {}),
        ...(model !== undefined ? { model } : {}),
        background: true,
        toolsOverride: [...tools],
      });
      const run = coordinator.getLiveRun(agentId, convo());
      return {
        content: [{ type: 'text', text: `spawned ${workerId} (${role})` }],
        details: { workerId, runId: run?.runId, status: 'spawning' as const },
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
      'Answer a worker that is waiting on you, or steer a running worker with an additional instruction. Use this between wait_workers calls to unblock or redirect a worker, then wait again. Steers are capped per worker; a worker that has already FINISHED is resumed with your message instead, keeping its context.',
    parameters: SEND_TO_WORKER_PARAMETERS,
    execute: async (_id, params) => {
      const p = asRecord(params);
      const workerId = typeof p.workerId === 'string' ? p.workerId : '';
      const message = typeof p.message === 'string' ? p.message : '';
      if (!workerId) throw new Error('workerId is required.');
      if (!message) throw new Error('message is required.');
      // §5.2: `send_to_worker` = `send_message`. One gate for both outcomes —
      // a RUNNING child queues it, a FINISHED one is resumed with it — where
      // the pre-D8 path (`coordinator.sendToWorker`) could only steer a live
      // handle and answered `ok: false` for a child that had finished.
      //
      // `sendToChild` THROWS for the refusals `send_message` reports as errors
      // (unknown target, one-shot, steer cap). The legacy tool's result shape
      // is `{ ok, status, workerId }` and a legacy caller reads `ok` — E1's
      // assertion 8 reads these results — so a refusal stays a not-ok RESULT
      // here rather than becoming an isError.
      let ok: boolean;
      let status: WorkerStatus;
      try {
        const res = coordinator.sendToChild(convo(), workerId, message);
        ok = res.ok;
        status = res.status;
      } catch {
        ok = false;
        status = coordinator.findWorker(agentId, convo(), workerId)?.status ?? 'cancelled';
      }
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
 * (subagent_progress{waiting_input}) until the orchestrator answers (send_to_worker),
 * the run closes, the pi signal aborts, or a 10-minute timeout elapses.
 *
 * `closed` is the run's `closed` signal; it is combined with pi's per-call
 * signal via AbortSignal.any so either aborts the wait. A run-closed / timeout /
 * cancel rejection propagates as a thrown Error (pi → isError result).
 */
export function createAskOrchestratorTool(
  handle: QuestionHost,
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
