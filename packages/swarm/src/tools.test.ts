import type { AgentEvent } from '@dash/agent';
import { SwarmCoordinator } from './coordinator.js';
import type { AttachOptions } from './coordinator.js';
import { createAskOrchestratorTool, createSwarmTools } from './tools.js';
import type { SwarmExtraTool, WorkerBackend, WorkerFactory, WorkerSpec } from './types.js';
import { WorkerHandle } from './worker-handle.js';

const AGENT_ID = 'agent-1';
const CONVO_ID = 'convo-1';

/**
 * A minimal fake WorkerBackend whose chat() generator blocks forever (no events,
 * never completes) so spawned workers stay in the `running` state. Tests that
 * need a worker to terminate drive the run's `closed` signal (finalize) instead.
 */
class IdleBackend implements WorkerBackend {
  abortCalls = 0;
  stopCalls = 0;
  private release: (() => void) | undefined;

  async *chat(_message: string): AsyncGenerator<AgentEvent> {
    // Block until abort() releases us; yield nothing.
    await new Promise<void>((resolve) => {
      this.release = resolve;
    });
  }

  abort(): void {
    this.abortCalls++;
    this.release?.();
  }

  async stop(): Promise<void> {
    this.stopCalls++;
  }
}

/** A WorkerFactory handing out IdleBackends and recording specs it received. */
function makeFactory() {
  const backends: IdleBackend[] = [];
  const specs: WorkerSpec[] = [];
  const factory: WorkerFactory = async (spec) => {
    specs.push(spec);
    const backend = new IdleBackend();
    backends.push(backend);
    return backend;
  };
  return { factory, backends, specs };
}

function baseAttach(overrides: Partial<AttachOptions> = {}): AttachOptions {
  return {
    agentId: AGENT_ID,
    agentName: 'Agent One',
    conversationId: CONVO_ID,
    orchestratorModel: 'orch-model',
    ...overrides,
  };
}

/** Build a coordinator + live attachment + the orchestrator tools over it. */
function setup(overrides: Partial<AttachOptions> = {}) {
  const { factory, backends, specs } = makeFactory();
  const coord = new SwarmCoordinator({ workerFactory: factory });
  const attachment = coord.attach(baseAttach(overrides));
  const tools = createSwarmTools({
    coordinator: coord,
    agentId: AGENT_ID,
    conversationId: () => CONVO_ID,
  });
  const byName = new Map(tools.map((t) => [t.name, t]));
  return { coord, attachment, tools, byName, backends, specs };
}

function tool(byName: Map<string, SwarmExtraTool>, name: string): SwarmExtraTool {
  const t = byName.get(name);
  if (!t) throw new Error(`tool ${name} not found`);
  return t;
}

/** Wait until at least `n` backends have been constructed by the factory. */
async function waitForBackends(backends: IdleBackend[], n: number): Promise<void> {
  const deadline = Date.now() + 1000;
  while (backends.length < n) {
    if (Date.now() > deadline) throw new Error(`only ${backends.length}/${n} backends appeared`);
    await new Promise((r) => setTimeout(r, 1));
  }
}

describe('createSwarmTools', () => {
  it('returns the four orchestrator tools with the expected names and no __ in any name', () => {
    const { tools } = setup();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(['spawn_worker', 'wait_workers', 'send_to_worker', 'check_workers']);
    for (const t of tools) {
      expect(t.name).not.toContain('__');
      expect(typeof t.label).toBe('string');
      expect(typeof t.description).toBe('string');
      expect(t.parameters).toBeTruthy();
      expect(typeof t.execute).toBe('function');
    }
  });

  it('every tool description teaches the loop (mentions wait, and caps/workspace somewhere)', () => {
    const { tools } = setup();
    const all = tools
      .map((t) => t.description)
      .join('\n')
      .toLowerCase();
    expect(all).toContain('wait');
    expect(all).toContain('workspace');
    expect(all).toContain('cap');
  });

  describe('spawn_worker', () => {
    it('spawns a worker via the real coordinator and returns "spawned <id> (<role>)" + details', async () => {
      const { byName, backends } = setup();
      const res = await tool(byName, 'spawn_worker').execute('call-1', {
        role: 'researcher',
        brief: 'investigate the auth flow',
      });
      const details = res.details as { workerId: string; runId: string; status: string };
      expect(details.status).toBe('spawning');
      expect(details.workerId).toBeTruthy();
      expect(details.runId).toBeTruthy();
      expect(res.content[0].text).toBe(`spawned ${details.workerId} (researcher)`);
      // Real coordinator constructed a backend for it (emits synchronously).
      await waitForBackends(backends, 1);
    });

    it('emits worker_spawned synchronously into the run channel (observed via getLiveRun)', async () => {
      const { coord, byName } = setup();
      await tool(byName, 'spawn_worker').execute('call-1', { role: 'r', brief: 'b' });
      const run = coord.getLiveRun(AGENT_ID, CONVO_ID);
      if (!run) throw new Error('expected a live run');
      // The synchronously-pushed worker_spawned event is the first channel item.
      const first = await run.channel.take();
      expect(first.done).toBe(false);
      expect((first.value as AgentEvent).type).toBe('worker_spawned');
    });

    it('throws when a per-run cap is exceeded (maxWorkersPerRun)', async () => {
      const { factory } = makeFactory();
      const coord = new SwarmCoordinator({ workerFactory: factory });
      coord.attach(baseAttach({ caps: { maxWorkersPerRun: 1 } }));
      const tools = createSwarmTools({
        coordinator: coord,
        agentId: AGENT_ID,
        conversationId: () => CONVO_ID,
      });
      const spawn = tools.find((t) => t.name === 'spawn_worker') as SwarmExtraTool;
      await spawn.execute('c1', { role: 'r1', brief: 'b1' });
      await expect(spawn.execute('c2', { role: 'r2', brief: 'b2' })).rejects.toThrow(/limit/);
    });

    it('throws when the swarm turn is closed (no live attachment)', async () => {
      const { factory } = makeFactory();
      const coord = new SwarmCoordinator({ workerFactory: factory });
      const tools = createSwarmTools({
        coordinator: coord,
        agentId: AGENT_ID,
        conversationId: () => CONVO_ID,
      });
      const spawn = tools.find((t) => t.name === 'spawn_worker') as SwarmExtraTool;
      await expect(spawn.execute('c1', { role: 'r', brief: 'b' })).rejects.toThrow(
        /swarm turn is closed/,
      );
    });
  });

  describe('wait_workers', () => {
    it('passes its pi-provided signal through; an already-aborted signal makes it throw', async () => {
      const { byName } = setup();
      await tool(byName, 'spawn_worker').execute('c1', { role: 'r', brief: 'b' });
      const aborted = AbortSignal.abort();
      await expect(tool(byName, 'wait_workers').execute('c2', {}, aborted)).rejects.toThrow();
    });

    it('returns a compact per-worker text summary plus a structured details array once workers settle', async () => {
      const { coord, byName } = setup();
      await tool(byName, 'spawn_worker').execute('c1', { role: 'r', brief: 'b' });
      // Finalize the run so the worker reaches a terminal (cancelled) state and
      // wait resolves via the run's `closed` signal rather than blocking.
      coord.getLiveRun(AGENT_ID, CONVO_ID); // ensure run exists
      // Wait then finalize concurrently.
      const waitP = tool(byName, 'wait_workers').execute('c2', {});
      coord.stop();
      const res = await waitP;
      const details = res.details as {
        workers: Array<{ workerId: string; status: string }>;
      };
      expect(Array.isArray(details.workers)).toBe(true);
      expect(details.workers.length).toBeGreaterThanOrEqual(1);
      expect(typeof res.content[0].text).toBe('string');
      expect(res.content[0].text.length).toBeGreaterThan(0);
    });
  });

  describe('send_to_worker', () => {
    it('delegates to coordinator.sendToWorker (unknown worker returns a not-ok result, not a throw)', async () => {
      const { byName } = setup();
      await tool(byName, 'spawn_worker').execute('c1', { role: 'r', brief: 'b' });
      const res = await tool(byName, 'send_to_worker').execute('c2', {
        workerId: 'does-not-exist',
        message: 'hi',
      });
      const details = res.details as { ok: boolean };
      expect(details.ok).toBe(false);
    });

    it('delegates a steer to a live worker and reports ok', async () => {
      const { coord, byName } = setup();
      const spawn = await tool(byName, 'spawn_worker').execute('c1', { role: 'r', brief: 'b' });
      const workerId = (spawn.details as { workerId: string }).workerId;
      const res = await tool(byName, 'send_to_worker').execute('c2', {
        workerId,
        message: 'also check the logout path',
      });
      const details = res.details as { ok: boolean; status: string };
      expect(details.ok).toBe(true);
      // Sanity: the coordinator agrees.
      const check = coord.checkWorkers(AGENT_ID, CONVO_ID);
      expect(check.find((w) => w.workerId === workerId)).toBeDefined();
    });
  });

  describe('check_workers', () => {
    it('delegates to coordinator.checkWorkers and returns the roster', async () => {
      const { byName } = setup();
      const spawn = await tool(byName, 'spawn_worker').execute('c1', {
        role: 'analyst',
        brief: 'b',
      });
      const workerId = (spawn.details as { workerId: string }).workerId;
      const res = await tool(byName, 'check_workers').execute('c2', {});
      const details = res.details as {
        workers: Array<{ workerId: string; role: string; status: string }>;
      };
      expect(details.workers.some((w) => w.workerId === workerId && w.role === 'analyst')).toBe(
        true,
      );
      expect(typeof res.content[0].text).toBe('string');
    });

    it('returns an empty roster when no run exists yet', async () => {
      const { byName } = setup();
      const res = await tool(byName, 'check_workers').execute('c1', {});
      const details = res.details as { workers: unknown[] };
      expect(details.workers).toEqual([]);
    });
  });
});

/** A minimal WorkerHandle harness for the worker-side ask_orchestrator tool. */
function makeHandle() {
  const emitted: AgentEvent[] = [];
  let terminalCalls = 0;
  const handle = new WorkerHandle({
    spec: {
      agentId: AGENT_ID,
      agentName: 'Agent One',
      runId: 'run-1',
      workerId: 'w-1',
      role: 'worker',
      brief: 'do the thing',
      model: 'orch-model',
      workspace: '/tmp',
      tools: [],
    },
    // Never resolves: the worker stays 'spawning' until start()/cancel drive it.
    backendPromise: new Promise<WorkerBackend>(() => {}),
    emit: (e) => emitted.push(e),
    maxSteers: 10,
    onTerminal: () => {
      terminalCalls++;
    },
  });
  return { handle, emitted, terminal: () => terminalCalls };
}

describe('createAskOrchestratorTool', () => {
  it('has the name ask_orchestrator with no __ and a question parameter', () => {
    const { handle } = makeHandle();
    const t = createAskOrchestratorTool(handle, new AbortController().signal);
    expect(t.name).toBe('ask_orchestrator');
    expect(t.name).not.toContain('__');
    const schema = t.parameters as { properties?: Record<string, unknown> };
    expect(schema.properties && 'question' in schema.properties).toBe(true);
  });

  it('resolves with the orchestrator answer when the handle is answered', async () => {
    const { handle } = makeHandle();
    const closed = new AbortController().signal;
    const t = createAskOrchestratorTool(handle, closed);
    const p = t.execute('call-1', { question: 'which db?' }, undefined);
    // The worker is now waiting for input; answer it.
    // Give the microtask a beat so waitForQuestion has registered the waiter.
    await new Promise((r) => setTimeout(r, 1));
    expect(handle.answerQuestion('use postgres')).toBe(true);
    const res = await p;
    expect(res.content[0].text).toBe('use postgres');
  });

  it('throws when the run-closed signal aborts (combined signal)', async () => {
    const { handle } = makeHandle();
    const closedController = new AbortController();
    const t = createAskOrchestratorTool(handle, closedController.signal);
    const p = t.execute('call-1', { question: 'which db?' }, undefined);
    await new Promise((r) => setTimeout(r, 1));
    closedController.abort();
    await expect(p).rejects.toThrow();
  });

  it('throws when the pi-provided signal aborts (combined signal)', async () => {
    const { handle } = makeHandle();
    const closed = new AbortController().signal;
    const piController = new AbortController();
    const t = createAskOrchestratorTool(handle, closed);
    const p = t.execute('call-1', { question: 'which db?' }, piController.signal);
    await new Promise((r) => setTimeout(r, 1));
    piController.abort();
    await expect(p).rejects.toThrow();
  });

  it('tolerates an undefined pi signal (only the closed signal is combined)', async () => {
    const { handle } = makeHandle();
    const closedController = new AbortController();
    const t = createAskOrchestratorTool(handle, closedController.signal);
    const p = t.execute('call-1', { question: 'q' }, undefined);
    await new Promise((r) => setTimeout(r, 1));
    // Answering still resolves it (proves the undefined signal was filtered out,
    // not passed to AbortSignal.any which would throw on a non-signal).
    expect(handle.answerQuestion('answer')).toBe(true);
    const res = await p;
    expect(res.content[0].text).toBe('answer');
  });
});
