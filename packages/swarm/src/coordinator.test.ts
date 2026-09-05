import type { AgentEvent } from '@dash/agent';
import { SwarmCoordinator } from './coordinator.js';
import type { AttachOptions } from './coordinator.js';
import {
  type WorkerBackend,
  type WorkerFactory,
  createFakeChildDriver,
} from './fake-child-driver.js';
import type { SwarmEventLogSink, WorkerSpec } from './types.js';

/** A deferred promise, resolved/rejected externally. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * A scripted fake WorkerBackend whose chat() generator is driven step-by-step.
 * The test emits events / completes the segment via the controller returned by
 * onNextSegment(), giving precise control over interleaving.
 */
interface SegmentController {
  message: string;
  emit(event: AgentEvent): Promise<void>;
  complete(): void;
}

class FakeBackend implements WorkerBackend {
  segments: SegmentController[] = [];
  abortCalls = 0;
  stopCalls = 0;
  /** Set to true to make stop() hang forever (proves teardown does not await it). */
  hangStop = false;
  private segmentStarted: Array<(c: SegmentController) => void> = [];
  /** Segments that started before onNextSegment() was called, awaiting a consumer. */
  private pendingSegments: SegmentController[] = [];

  /**
   * Resolves with the next segment's controller. Robust to ordering: if a
   * segment already started (chat() was called) and no consumer has claimed it,
   * it is returned immediately. Otherwise resolves when the next segment starts.
   */
  onNextSegment(): Promise<SegmentController> {
    const pending = this.pendingSegments.shift();
    if (pending) return Promise.resolve(pending);
    return new Promise((resolve) => this.segmentStarted.push(resolve));
  }

  async *chat(message: string): AsyncGenerator<AgentEvent> {
    const queue: AgentEvent[] = [];
    const takers: Array<(r: IteratorResult<AgentEvent>) => void> = [];
    let done = false;

    const controller: SegmentController = {
      message,
      emit: (event: AgentEvent) => {
        const taker = takers.shift();
        if (taker) taker({ done: false, value: event });
        else queue.push(event);
        return Promise.resolve();
      },
      complete: () => {
        done = true;
        for (const t of takers.splice(0)) t({ done: true, value: undefined as never });
      },
    };
    this.segments.push(controller);
    const waiter = this.segmentStarted.shift();
    if (waiter) waiter(controller);
    else this.pendingSegments.push(controller);

    while (true) {
      if (queue.length > 0) {
        yield queue.shift() as AgentEvent;
        continue;
      }
      if (done) return;
      const next = await new Promise<IteratorResult<AgentEvent>>((resolve) => {
        takers.push(resolve);
      });
      if (next.done) return;
      yield next.value;
    }
  }

  abort(): void {
    this.abortCalls++;
  }

  async stop(): Promise<void> {
    this.stopCalls++;
    if (this.hangStop) {
      await new Promise<void>(() => {});
    }
  }
}

/** A WorkerFactory that hands out FakeBackends and records the specs it received. */
function makeFactory() {
  const backends: FakeBackend[] = [];
  const specs: WorkerSpec[] = [];
  /** Gate that each factory call awaits before resolving, if set. */
  let gate: Promise<void> | undefined;
  const factory: WorkerFactory = async (spec) => {
    specs.push(spec);
    if (gate) await gate;
    const backend = new FakeBackend();
    backends.push(backend);
    return backend;
  };
  return {
    factory,
    backends,
    specs,
    setGate(p: Promise<void>) {
      gate = p;
    },
  };
}

/** A fake event-log sink recording every append. */
function makeEventLog() {
  const appends: Array<{
    agentId: string;
    conversationId: string;
    messageId: string;
    payload: { type: 'event'; event: AgentEvent };
  }> = [];
  const sink: SwarmEventLogSink = {
    append(agentId, conversationId, messageId, payload) {
      appends.push({ agentId, conversationId, messageId, payload });
      return Promise.resolve();
    },
  };
  return { sink, appends };
}

/** Mirror of the coordinator's terminal set, for assertions. */
const TERMINAL = new Set(['done', 'failed', 'cancelled', 'interrupted', 'max_turns']);

const AGENT_ID = 'agent-1';
const CONVO_ID = 'convo-1';

function baseAttach(overrides: Partial<AttachOptions> = {}): AttachOptions {
  return {
    agentId: AGENT_ID,
    agentName: 'Agent One',
    conversationId: CONVO_ID,
    orchestratorModel: 'orch-model',
    ...overrides,
  };
}

/** Wait until at least `n` backends have been constructed by the factory. */
async function waitForBackends(backends: FakeBackend[], n: number): Promise<void> {
  const deadline = Date.now() + 1000;
  while (backends.length < n) {
    if (Date.now() > deadline) throw new Error(`only ${backends.length}/${n} backends appeared`);
    await new Promise((r) => setTimeout(r, 1));
  }
}

/** Drain a channel into an array until it closes (test helper). */
async function drain(channel: {
  take(): Promise<IteratorResult<AgentEvent>>;
}): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  while (true) {
    const r = await channel.take();
    if (r.done) break;
    out.push(r.value);
  }
  return out;
}

/** Advance one macrotask so channel drains and worker transitions settle. */
function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

/** A WorkerBackend that replays a fixed script of events and then completes. */
class ScriptedBackend implements WorkerBackend {
  constructor(private readonly script: AgentEvent[]) {}

  async *chat(): AsyncGenerator<AgentEvent> {
    for (const event of this.script) yield event;
  }

  abort(): void {}

  async stop(): Promise<void> {}
}

/**
 * Attaches a live turn whose workers are backed by ScriptedBackends, and drains
 * the attachment channel into `events` in the background. Every spawned worker
 * replays the same `script` and then finalizes (an empty script finalizes at
 * once with an empty report).
 */
function setupLiveTurn(opts: { script?: AgentEvent[] } = {}) {
  const script = opts.script ?? [];
  const specs: WorkerSpec[] = [];
  const factory: WorkerFactory = (spec) => {
    specs.push(spec);
    return Promise.resolve(new ScriptedBackend(script));
  };
  const coordinator = new SwarmCoordinator({ childDriver: createFakeChildDriver(factory) });
  const attachment = coordinator.attach(baseAttach());
  const events: AgentEvent[] = [];
  void (async () => {
    while (true) {
      const r = await attachment.channel.take();
      if (r.done) return;
      events.push(r.value);
    }
  })();
  return { coordinator, attachment, events, specs, flush };
}

describe('SwarmCoordinator', () => {
  // Behavior 1: ownership.
  describe('ownership', () => {
    it('a second attach on a live key is non-authoritative (dead channel, aborted closed, no-op finalize)', () => {
      const { factory } = makeFactory();
      const coord = new SwarmCoordinator({ childDriver: createFakeChildDriver(factory) });
      const a = coord.attach(baseAttach());
      const b = coord.attach(baseAttach());

      expect(a.live).toBe(true);
      expect(b.live).toBe(false);
      expect(b.closed.aborted).toBe(true);
      // b's channel is dead: a push is a no-op / take reports done.
      b.channel.push({ type: 'text_delta', text: 'x' });
      // finalize on b must not throw and must not affect a.
      expect(() => b.finalize({ consumerAlive: true })).not.toThrow();
      expect(a.live).toBe(true);
    });

    it("second attach's finalize does not cancel the first attachment's workers; spawn still routes to A", async () => {
      const { factory, backends } = makeFactory();
      const coord = new SwarmCoordinator({ childDriver: createFakeChildDriver(factory) });
      const a = coord.attach(baseAttach());
      coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r', brief: 'b' });
      await backends[0].onNextSegment();

      const b = coord.attach(baseAttach());
      b.finalize({ consumerAlive: false }); // stale token: must be a no-op

      expect(backends[0].abortCalls).toBe(0);
      // A's run is still live: another spawn succeeds and routes to A.
      const spawned = coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r2', brief: 'b2' });
      expect(spawned.status).toBe('spawning');
      const runs = coord.getRuns(AGENT_ID);
      expect(runs).toHaveLength(1);
      expect(runs[0].runId).toBe(a.runIdHint);
    });
  });

  /**
   * The seam worktree cleanup hangs off: the gateway builds the child's
   * worktree when it built the child and needs a matching notification on EVERY
   * terminal path to take it down again.
   */
  describe('onWorkerFinished', () => {
    it('reports each finished worker spec to the coordinator-level hook', async () => {
      const finished: Array<Omit<WorkerSpec, 'extraTools'>> = [];
      const factory: WorkerFactory = () => Promise.resolve(new ScriptedBackend([]));
      const coord = new SwarmCoordinator({
        childDriver: createFakeChildDriver(factory),
        onWorkerFinished: (spec) => {
          finished.push(spec);
        },
      });
      const a = coord.attach(baseAttach({ workspace: '/repo' }));
      void drain(a.channel);
      coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r', brief: 'b', isolation: 'worktree' });
      await flush();

      expect(finished).toHaveLength(1);
      expect(finished[0]).toMatchObject({
        agentName: 'Agent One',
        workspace: '/repo',
        isolation: 'worktree',
      });
      expect(finished[0].workerId).toBeTruthy();
    });
  });

  // Behavior 2: lazy run + closed-turn refusal.
  describe('lazy run creation', () => {
    it('first spawnWorker creates the run under the live attachment', () => {
      const { factory } = makeFactory();
      const coord = new SwarmCoordinator({ childDriver: createFakeChildDriver(factory) });
      coord.attach(baseAttach());
      expect(coord.getRuns(AGENT_ID)).toHaveLength(0);
      coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r', brief: 'b' });
      expect(coord.getRuns(AGENT_ID)).toHaveLength(1);
    });

    it('spawnWorker throws "swarm turn is closed" when there is no live attachment', () => {
      const { factory } = makeFactory();
      const coord = new SwarmCoordinator({ childDriver: createFakeChildDriver(factory) });
      expect(() => coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r', brief: 'b' })).toThrow(
        /swarm turn is closed/,
      );
      // No orphan run was created.
      expect(coord.getRuns(AGENT_ID)).toHaveLength(0);
    });

    it('spawnWorker throws after the attachment is finalized (no zombie run)', () => {
      const { factory } = makeFactory();
      const coord = new SwarmCoordinator({ childDriver: createFakeChildDriver(factory) });
      const a = coord.attach(baseAttach());
      a.finalize({ consumerAlive: true });
      expect(() => coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r', brief: 'b' })).toThrow(
        /swarm turn is closed/,
      );
    });
  });

  // Behavior 3: gate re-read.
  describe('gate re-read', () => {
    it('throws when the agent gate reports disabled', () => {
      const { factory } = makeFactory();
      const coord = new SwarmCoordinator({ childDriver: createFakeChildDriver(factory) });
      coord.attach(baseAttach({ getAgentGate: () => ({ enabled: true, disabled: true }) }));
      expect(() => coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r', brief: 'b' })).toThrow();
    });

    it('throws when the agent gate reports not enabled', () => {
      const { factory } = makeFactory();
      const coord = new SwarmCoordinator({ childDriver: createFakeChildDriver(factory) });
      coord.attach(baseAttach({ getAgentGate: () => ({ enabled: false, disabled: false }) }));
      expect(() => coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r', brief: 'b' })).toThrow();
    });

    it('allows when the gate is enabled and not disabled', () => {
      const { factory } = makeFactory();
      const coord = new SwarmCoordinator({ childDriver: createFakeChildDriver(factory) });
      coord.attach(baseAttach({ getAgentGate: () => ({ enabled: true, disabled: false }) }));
      expect(() => coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r', brief: 'b' })).not.toThrow();
    });
  });

  // Behavior 4: caps.
  describe('caps', () => {
    it('throws at maxWorkersPerRun (total), message includes the cap', async () => {
      const { factory, backends } = makeFactory();
      const coord = new SwarmCoordinator({
        childDriver: createFakeChildDriver(factory),
        defaultCaps: { maxWorkersPerRun: 2, maxConcurrentWorkers: 100 },
      });
      coord.attach(baseAttach());
      coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r', brief: 'b' });
      coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r', brief: 'b' });
      // Complete the first two so they are terminal — total still counts them.
      await waitForBackends(backends, 2);
      for (const b of backends) {
        const seg = await b.onNextSegment();
        seg.complete();
      }
      // Let both terminal transitions settle.
      await new Promise((r) => setTimeout(r, 5));
      expect(() => coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r', brief: 'b' })).toThrow(/2/);
    });

    it('throws at maxConcurrentWorkers with "wait for workers to finish"', () => {
      const { factory } = makeFactory();
      const coord = new SwarmCoordinator({
        childDriver: createFakeChildDriver(factory),
        defaultCaps: { maxConcurrentWorkers: 1, maxWorkersPerRun: 100 },
      });
      coord.attach(baseAttach());
      coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r', brief: 'b' });
      expect(() => coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r', brief: 'b' })).toThrow(
        /wait for workers to finish/,
      );
    });

    it('enforces a global concurrent ceiling across all runs', () => {
      const { factory } = makeFactory();
      const coord = new SwarmCoordinator({
        childDriver: createFakeChildDriver(factory),
        globalMaxConcurrentWorkers: 1,
        defaultCaps: { maxConcurrentWorkers: 100, maxWorkersPerRun: 100 },
      });
      coord.attach(baseAttach({ agentId: 'a1', conversationId: 'c1' }));
      coord.attach(baseAttach({ agentId: 'a2', conversationId: 'c2' }));
      coord.spawnWorker('a1', 'c1', { role: 'r', brief: 'b' });
      expect(coord.activeWorkerCount()).toBe(1);
      expect(() => coord.spawnWorker('a2', 'c2', { role: 'r', brief: 'b' })).toThrow();
    });
  });

  // Behavior 5: model validation.
  describe('model validation', () => {
    it('accepts the orchestrator model, fallbacks, and allowedModels; rejects others', () => {
      const { factory } = makeFactory();
      const coord = new SwarmCoordinator({ childDriver: createFakeChildDriver(factory) });
      coord.attach(
        baseAttach({
          orchestratorModel: 'orch',
          orchestratorFallbackModels: ['fb'],
          allowedModels: ['extra'],
        }),
      );
      expect(() =>
        coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r', brief: 'b', model: 'orch' }),
      ).not.toThrow();
      expect(() =>
        coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r', brief: 'b', model: 'fb' }),
      ).not.toThrow();
      expect(() =>
        coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r', brief: 'b', model: 'extra' }),
      ).not.toThrow();
      expect(() =>
        coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r', brief: 'b', model: 'nope' }),
      ).toThrow(/nope/);
    });
  });

  // Behavior 6: tool validation.
  describe('tool validation', () => {
    it('accepts a subset of the default tool names', () => {
      const { factory } = makeFactory();
      const coord = new SwarmCoordinator({ childDriver: createFakeChildDriver(factory) });
      coord.attach(baseAttach());
      expect(() =>
        coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r', brief: 'b', tools: ['read', 'grep'] }),
      ).not.toThrow();
    });

    it('rejects a tool the orchestrator itself does not have', () => {
      const { factory } = makeFactory();
      const coord = new SwarmCoordinator({ childDriver: createFakeChildDriver(factory) });
      coord.attach(baseAttach({ orchestratorTools: ['read', 'grep'] }));
      expect(() =>
        coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r', brief: 'b', tools: ['bash'] }),
      ).toThrow(/bash/);
    });

    it('rejects mcp-prefixed, _skill-suffixed, and unknown tools naming the offender', () => {
      const { factory } = makeFactory();
      const coord = new SwarmCoordinator({ childDriver: createFakeChildDriver(factory) });
      coord.attach(baseAttach({ orchestratorTools: undefined }));
      expect(() =>
        coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r', brief: 'b', tools: ['mcp__x'] }),
      ).toThrow(/mcp__x/);
      expect(() =>
        coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r', brief: 'b', tools: ['create_skill'] }),
      ).toThrow(/create_skill/);
      expect(() =>
        coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r', brief: 'b', tools: ['wat'] }),
      ).toThrow(/wat/);
    });

    it('accepts the always-available tools, which no config.tools list has to name', () => {
      const { factory, specs } = makeFactory();
      const coord = new SwarmCoordinator({ childDriver: createFakeChildDriver(factory) });
      coord.attach(baseAttach({ orchestratorTools: ['read'] }));
      coord.spawnWorker(AGENT_ID, CONVO_ID, {
        role: 'r',
        brief: 'b',
        tools: ['read', 'load_skill', 'task'],
      });
      expect(specs[0].tools).toEqual(['read', 'load_skill', 'task']);
    });

    it('an OMITTED tools list defaults to the read-only subset the PARENT holds', () => {
      const { factory, specs } = makeFactory();
      const coord = new SwarmCoordinator({ childDriver: createFakeChildDriver(factory) });
      // `spawn_worker`'s `tools` is optional: a worker spawned without one must
      // not be handed tools the orchestrator itself lacks.
      coord.attach(baseAttach({ orchestratorTools: ['bash'] }));
      coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r', brief: 'b' });
      expect(specs[0].tools).toEqual([]);
    });

    it('the omitted-tools default is still the read-only four for a default parent', () => {
      const { factory, specs } = makeFactory();
      const coord = new SwarmCoordinator({ childDriver: createFakeChildDriver(factory) });
      coord.attach(baseAttach({ orchestratorTools: undefined }));
      coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r', brief: 'b' });
      expect(specs[0].tools).toEqual(['read', 'grep', 'find', 'ls']);
    });

    it('an EXPLICIT empty grant stays empty — it is not widened to the default', () => {
      const { factory, specs } = makeFactory();
      const coord = new SwarmCoordinator({ childDriver: createFakeChildDriver(factory) });
      coord.attach(
        baseAttach({ orchestratorTools: ['bash'], orchestratorMcpTools: ['github__pr'] }),
      );
      // An MCP-only (or spawn-only) child resolves to zero BUILT-INS on purpose.
      coord.spawnWorker(AGENT_ID, CONVO_ID, {
        role: 'r',
        brief: 'b',
        tools: [],
        mcpTools: ['github__pr'],
      });
      expect(specs[0].tools).toEqual([]);
    });

    it('bounds the child grant by parentBuiltinTools — the same list the agent tool reads', () => {
      const { factory } = makeFactory();
      const coord = new SwarmCoordinator({ childDriver: createFakeChildDriver(factory) });
      coord.attach(baseAttach({ orchestratorTools: ['read', 'grep'] }));
      // web_search is in UNIVERSE but the parent does not hold it.
      expect(() =>
        coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r', brief: 'b', tools: ['web_search'] }),
      ).toThrow(/the orchestrator does not have it/);
    });
  });

  // Behavior 6b: MCP tools are a separate, separately-validated grant.
  describe('mcp tool validation', () => {
    it('passes through MCP tools the parent holds', () => {
      const { factory, specs } = makeFactory();
      const coord = new SwarmCoordinator({ childDriver: createFakeChildDriver(factory) });
      coord.attach(baseAttach({ orchestratorMcpTools: ['github__pr', 'slack__post'] }));
      coord.spawnWorker(AGENT_ID, CONVO_ID, {
        role: 'r',
        brief: 'b',
        tools: ['read'],
        mcpTools: ['github__pr'],
      });
      expect(specs[0].mcpTools).toEqual(['github__pr']);
    });

    it('refuses an MCP tool the parent does not hold', () => {
      const { factory } = makeFactory();
      const coord = new SwarmCoordinator({ childDriver: createFakeChildDriver(factory) });
      coord.attach(baseAttach({ orchestratorMcpTools: ['github__pr'] }));
      expect(() =>
        coord.spawnWorker(AGENT_ID, CONVO_ID, {
          role: 'r',
          brief: 'b',
          tools: ['read'],
          mcpTools: ['slack__post'],
        }),
      ).toThrow(/slack__post/);
    });

    it('fails closed when the attachment declared no MCP tools at all', () => {
      const { factory } = makeFactory();
      const coord = new SwarmCoordinator({ childDriver: createFakeChildDriver(factory) });
      coord.attach(baseAttach());
      expect(() =>
        coord.spawnWorker(AGENT_ID, CONVO_ID, {
          role: 'r',
          brief: 'b',
          tools: ['read'],
          mcpTools: ['github__pr'],
        }),
      ).toThrow(/github__pr/);
    });

    it('carries spawnableTypes and canSpawn onto the worker spec', () => {
      const { factory, specs } = makeFactory();
      const coord = new SwarmCoordinator({ childDriver: createFakeChildDriver(factory) });
      coord.attach(baseAttach());
      coord.spawnWorker(AGENT_ID, CONVO_ID, {
        role: 'r',
        brief: 'b',
        tools: ['read'],
        spawnableTypes: ['Explore'],
        canSpawn: true,
      });
      expect(specs[0].spawnableTypes).toEqual(['Explore']);
      expect(specs[0].canSpawn).toBe(true);
    });

    it('uses the default subset when tools is omitted', () => {
      const { factory, specs } = makeFactory();
      const coord = new SwarmCoordinator({ childDriver: createFakeChildDriver(factory) });
      coord.attach(baseAttach());
      coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r', brief: 'b' });
      expect(specs[0].tools).toEqual(['read', 'grep', 'find', 'ls']);
    });
  });

  // Behavior 7: sync registration.
  describe('sync registration', () => {
    it('emits worker_spawned + agent_spawned synchronously before any await', () => {
      const { factory } = makeFactory();
      const coord = new SwarmCoordinator({ childDriver: createFakeChildDriver(factory) });
      const a = coord.attach(baseAttach());
      const seen: AgentEvent[] = [];
      // Take twice; the events must already be buffered synchronously.
      void a.channel.take().then((r) => {
        if (!r.done) seen.push(r.value);
      });
      void a.channel.take().then((r) => {
        if (!r.done) seen.push(r.value);
      });
      coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'planner', brief: 'b' });
      // The events were pushed synchronously inside spawnWorker.
      return Promise.resolve().then(() => {
        const types = seen.map((e) => e.type);
        expect(types).toContain('worker_spawned');
        expect(types).toContain('agent_spawned');
        const spawnedAgent = seen.find((e) => e.type === 'agent_spawned');
        expect(spawnedAgent).toMatchObject({ type: 'agent_spawned', name: 'planner' });
      });
    });

    it('registers the handle in spawning status before the factory promise resolves', () => {
      const { factory, setGate } = makeFactory();
      const gate = deferred<void>();
      setGate(gate.promise);
      const coord = new SwarmCoordinator({ childDriver: createFakeChildDriver(factory) });
      coord.attach(baseAttach());
      const spawned = coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r', brief: 'b' });
      // spawnWorker reports 'spawning' to the tool caller.
      expect(spawned.status).toBe('spawning');
      // Same synchronous batch (before the gated factory promise resolves): the
      // worker is already visible and non-terminal via checkWorkers, so a
      // same-batch wait_workers observes the in-flight worker.
      const checked = coord.checkWorkers(AGENT_ID, CONVO_ID);
      expect(checked).toHaveLength(1);
      expect(checked[0].workerId).toBe(spawned.workerId);
      expect(['spawning', 'running']).toContain(checked[0].status);
      gate.resolve();
    });
  });

  // Behavior 8: waitWorkers.
  describe('waitWorkers', () => {
    it('resolves with statuses when all referenced workers become terminal', async () => {
      const { factory, backends } = makeFactory();
      const coord = new SwarmCoordinator({ childDriver: createFakeChildDriver(factory) });
      coord.attach(baseAttach());
      const { workerId } = coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r', brief: 'b' });
      const seg = await backends[0].onNextSegment();
      await seg.emit({
        type: 'response',
        content: 'done!',
        usage: { inputTokens: 0, outputTokens: 0 },
      });
      const waitP = coord.waitWorkers(AGENT_ID, CONVO_ID, { workerIds: [workerId] });
      seg.complete();
      const result = await waitP;
      expect(result).toHaveLength(1);
      expect(result[0].status).toBe('done');
      expect(result[0].report).toBe('done!');
    });

    it('resolves as soon as any referenced worker becomes waiting_input', async () => {
      const { factory, backends } = makeFactory();
      const coord = new SwarmCoordinator({ childDriver: createFakeChildDriver(factory) });
      coord.attach(baseAttach());
      const { workerId } = coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r', brief: 'b' });
      await backends[0].onNextSegment();
      const waitP = coord.waitWorkers(AGENT_ID, CONVO_ID, { workerIds: [workerId] });
      // Drive the live worker into waiting_input via the real handle path
      // (as the ask_orchestrator tool would).
      const run = coord.getLiveRun(AGENT_ID, CONVO_ID);
      if (!run) throw new Error('expected a live run');
      const handle = run.getHandle(workerId);
      if (!handle) throw new Error('expected a live handle');
      void handle.waitForQuestion('need input?', undefined, 60_000);
      const res = await waitP;
      expect(res[0].workerId).toBe(workerId);
      expect(res[0].status).toBe('waiting_input');
      expect(res[0].question).toBe('need input?');
    });

    it('returns current statuses on timeout (does not throw)', async () => {
      vi.useFakeTimers();
      try {
        const { factory, backends } = makeFactory();
        const coord = new SwarmCoordinator({ childDriver: createFakeChildDriver(factory) });
        coord.attach(baseAttach());
        const { workerId } = coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r', brief: 'b' });
        await backends[0].onNextSegment();
        const waitP = coord.waitWorkers(AGENT_ID, CONVO_ID, {
          workerIds: [workerId],
          timeoutSeconds: 5,
        });
        await vi.advanceTimersByTimeAsync(5_000);
        const res = await waitP;
        expect(res).toHaveLength(1);
        // Not terminal — still running.
        expect(['spawning', 'running']).toContain(res[0].status);
      } finally {
        vi.useRealTimers();
      }
    });

    it('returns statuses when the attachment closes (finalize) while waiting', async () => {
      const { factory, backends } = makeFactory();
      const coord = new SwarmCoordinator({ childDriver: createFakeChildDriver(factory) });
      const a = coord.attach(baseAttach());
      const { workerId } = coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r', brief: 'b' });
      await backends[0].onNextSegment();
      const waitP = coord.waitWorkers(AGENT_ID, CONVO_ID, { workerIds: [workerId] });
      a.finalize({ consumerAlive: false });
      const res = await waitP;
      expect(res).toHaveLength(1);
    });

    it('throws Error("aborted") when the passed signal aborts', async () => {
      const { factory, backends } = makeFactory();
      const coord = new SwarmCoordinator({ childDriver: createFakeChildDriver(factory) });
      coord.attach(baseAttach());
      const { workerId } = coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r', brief: 'b' });
      await backends[0].onNextSegment();
      const ac = new AbortController();
      const waitP = coord.waitWorkers(AGENT_ID, CONVO_ID, { workerIds: [workerId] }, ac.signal);
      ac.abort();
      await expect(waitP).rejects.toThrow('aborted');
    });
  });

  // Behavior 9: wall clock.
  describe('wall clock', () => {
    it('cancels all workers, calls orchestratorAbort, and fires closed on expiry', async () => {
      vi.useFakeTimers();
      const orchestratorAbort = vi.fn();
      try {
        const { factory, backends } = makeFactory();
        const coord = new SwarmCoordinator({
          childDriver: createFakeChildDriver(factory),
          defaultCaps: { maxRunSeconds: 10 },
        });
        const a = coord.attach(baseAttach({ orchestratorAbort }));
        coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r', brief: 'b' });
        await backends[0].onNextSegment();
        expect(a.closed.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(backends[0].abortCalls).toBeGreaterThanOrEqual(1);
        expect(orchestratorAbort).toHaveBeenCalled();
        expect(a.closed.aborted).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // Behavior 10: finalize.
  describe('finalize', () => {
    it('is idempotent and only effective from the owning attachment', () => {
      const { factory } = makeFactory();
      const orchestratorAbort = vi.fn();
      const coord = new SwarmCoordinator({ childDriver: createFakeChildDriver(factory) });
      const a = coord.attach(baseAttach({ orchestratorAbort }));
      coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r', brief: 'b' });
      a.finalize({ consumerAlive: true });
      a.finalize({ consumerAlive: true });
      expect(orchestratorAbort).toHaveBeenCalledTimes(1);
    });

    it('pushes worker_done{cancelled} to the channel before closing it (consumerAlive)', async () => {
      const { factory, backends } = makeFactory();
      const coord = new SwarmCoordinator({ childDriver: createFakeChildDriver(factory) });
      const a = coord.attach(baseAttach());
      coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r', brief: 'b' });
      await backends[0].onNextSegment();
      a.finalize({ consumerAlive: true });
      const events = await drain(a.channel);
      const done = events.find((e) => e.type === 'worker_done');
      expect(done).toMatchObject({ type: 'worker_done', status: 'cancelled' });
    });

    it('returns synchronously even when a backend stop() hangs forever', async () => {
      const { factory, backends } = makeFactory();
      const coord = new SwarmCoordinator({ childDriver: createFakeChildDriver(factory) });
      const a = coord.attach(baseAttach());
      coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r', brief: 'b' });
      await backends[0].onNextSegment();
      backends[0].hangStop = true;
      const before = Date.now();
      a.finalize({ consumerAlive: true });
      // Returned synchronously (no await for stop settlement).
      expect(Date.now() - before).toBeLessThan(50);
      expect(backends[0].abortCalls).toBe(1);
    });

    it('appends terminal worker_done to the eventLog ONLY on consumer-gone finalize', async () => {
      const { factory, backends } = makeFactory();
      const { sink, appends } = makeEventLog();
      const coord = new SwarmCoordinator({
        childDriver: createFakeChildDriver(factory),
        eventLog: sink,
      });
      const a = coord.attach(baseAttach({ messageId: 'm-1' }));
      coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r', brief: 'b' });
      await backends[0].onNextSegment();
      a.finalize({ consumerAlive: false });
      await Promise.resolve();
      expect(appends.length).toBeGreaterThanOrEqual(1);
      expect(appends[0]).toMatchObject({
        agentId: AGENT_ID,
        conversationId: CONVO_ID,
        messageId: 'm-1',
        payload: { type: 'event', event: { type: 'worker_done' } },
      });
    });

    it('does not re-append a worker_done that already rode the live stream (completed before WS cancel)', async () => {
      const { factory, backends } = makeFactory();
      const { sink, appends } = makeEventLog();
      const coord = new SwarmCoordinator({
        childDriver: createFakeChildDriver(factory),
        eventLog: sink,
      });
      coord.attach(baseAttach({ messageId: 'm-1' }));

      // Worker A completes normally: its worker_done{done} was pushed to the
      // live channel at completion time (and logged by the chat-ws consumer).
      const { workerId: doneId } = coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'a', brief: 'b' });
      const segA = await backends[0].onNextSegment();
      segA.complete();
      await new Promise((r) => setTimeout(r, 0));
      const statuses = coord.checkWorkers(AGENT_ID, CONVO_ID);
      expect(statuses.find((w) => w.workerId === doneId)?.status).toBe('done');

      // Worker B is still running when the user cancels the turn over the WS.
      const { workerId: liveId } = coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'b', brief: 'b' });
      await backends[1].onNextSegment();

      expect(coord.cancelTurn(AGENT_ID, CONVO_ID)).toBe(true);
      await Promise.resolve();

      // Only worker B's cancellation was unlogged; re-appending worker A's done
      // event would duplicate it in the durable log.
      const logged = appends.map((x) => x.payload.event);
      expect(logged).toHaveLength(1);
      expect(logged[0]).toMatchObject({
        type: 'worker_done',
        workerId: liveId,
        status: 'cancelled',
      });
    });

    it('NEVER appends to the eventLog on consumerAlive finalize (avoids double-log)', async () => {
      const { factory, backends } = makeFactory();
      const { sink, appends } = makeEventLog();
      const coord = new SwarmCoordinator({
        childDriver: createFakeChildDriver(factory),
        eventLog: sink,
      });
      const a = coord.attach(baseAttach({ messageId: 'm-1' }));
      coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r', brief: 'b' });
      await backends[0].onNextSegment();
      a.finalize({ consumerAlive: true });
      await Promise.resolve();
      expect(appends).toHaveLength(0);
    });

    it('does not append on consumer-gone finalize when no messageId is set', async () => {
      const { factory, backends } = makeFactory();
      const { sink, appends } = makeEventLog();
      const coord = new SwarmCoordinator({
        childDriver: createFakeChildDriver(factory),
        eventLog: sink,
      });
      const a = coord.attach(baseAttach()); // no messageId
      coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r', brief: 'b' });
      await backends[0].onNextSegment();
      a.finalize({ consumerAlive: false });
      await Promise.resolve();
      expect(appends).toHaveLength(0);
    });

    it('clears the live attachment so subsequent spawn throws', () => {
      const { factory } = makeFactory();
      const coord = new SwarmCoordinator({ childDriver: createFakeChildDriver(factory) });
      const a = coord.attach(baseAttach());
      coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r', brief: 'b' });
      a.finalize({ consumerAlive: true });
      expect(() => coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r', brief: 'b' })).toThrow(
        /swarm turn is closed/,
      );
    });
  });

  // Ring buffer retention.
  describe('ring buffer', () => {
    it('retains the last 20 runs per agent; the 21st run evicts the 1st', () => {
      const { factory } = makeFactory();
      const coord = new SwarmCoordinator({ childDriver: createFakeChildDriver(factory) });
      const runIds: string[] = [];
      for (let i = 0; i < 21; i++) {
        const a = coord.attach(baseAttach({ conversationId: `c-${i}` }));
        runIds.push(a.runIdHint);
        coord.spawnWorker(AGENT_ID, `c-${i}`, { role: 'r', brief: 'b' });
        a.finalize({ consumerAlive: true });
      }
      const runs = coord.getRuns(AGENT_ID);
      expect(runs).toHaveLength(20);
      // The first run was evicted.
      expect(coord.getRun(AGENT_ID, runIds[0])).toBeUndefined();
      // The last run is retained.
      expect(coord.getRun(AGENT_ID, runIds[20])).toBeDefined();
    });
  });

  // Boot-time crash recovery: restored snapshots surface via the panel API.
  describe('restoreFinalizedRun', () => {
    function restoredSnapshot() {
      return {
        runId: 'crashed-run',
        agentId: AGENT_ID,
        conversationId: CONVO_ID,
        startedAt: 1000,
        endedAt: 2000,
        finalized: true,
        workerCount: 1,
        activeCount: 0,
        workers: [
          {
            workerId: 'w-1',
            role: 'researcher',
            status: 'cancelled' as const,
            brief: 'find things',
            model: 'orch-model',
            report: 'Gateway restarted while this worker was running.',
            usage: { inputTokens: 0, outputTokens: 0 },
            subagentType: 'general-purpose',
            description: 'researcher',
            toolCallCount: 0,
            background: false,
            oneShot: false,
          },
        ],
      };
    }

    it('a restored snapshot is listed by getRuns and retrievable by getRun', () => {
      const { factory } = makeFactory();
      const coord = new SwarmCoordinator({ childDriver: createFakeChildDriver(factory) });

      coord.restoreFinalizedRun(restoredSnapshot());

      const runs = coord.getRuns(AGENT_ID);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ runId: 'crashed-run', finalized: true, workerCount: 1 });
      const snap = coord.getRun(AGENT_ID, 'crashed-run');
      expect(snap?.workers[0]).toMatchObject({ workerId: 'w-1', status: 'cancelled' });
    });

    it('restored snapshots count toward the per-agent ring buffer cap', () => {
      const { factory } = makeFactory();
      const coord = new SwarmCoordinator({ childDriver: createFakeChildDriver(factory) });
      for (let i = 0; i < 21; i++) {
        coord.restoreFinalizedRun({ ...restoredSnapshot(), runId: `run-${i}` });
      }
      expect(coord.getRuns(AGENT_ID)).toHaveLength(20);
      expect(coord.getRun(AGENT_ID, 'run-0')).toBeUndefined();
      expect(coord.getRun(AGENT_ID, 'run-20')).toBeDefined();
    });
  });

  // Behavior 11: panel ops.
  describe('panel ops', () => {
    it('cancelWorker on a terminal worker returns {ok:false, reason:"worker terminal"}', async () => {
      const { factory, backends } = makeFactory();
      const coord = new SwarmCoordinator({ childDriver: createFakeChildDriver(factory) });
      const a = coord.attach(baseAttach());
      const { workerId } = coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r', brief: 'b' });
      const seg = await backends[0].onNextSegment();
      seg.complete();
      await new Promise((r) => setTimeout(r, 0));
      const res = coord.cancelWorker(AGENT_ID, a.runIdHint, workerId);
      expect(res).toEqual({ ok: false, reason: 'worker terminal' });
    });

    it('sendPanelMessage on a finalized run returns {ok:false, reason:"run finalized"}', () => {
      const { factory } = makeFactory();
      const coord = new SwarmCoordinator({ childDriver: createFakeChildDriver(factory) });
      const a = coord.attach(baseAttach());
      const { workerId } = coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r', brief: 'b' });
      const runId = a.runIdHint;
      a.finalize({ consumerAlive: true });
      const res = coord.sendPanelMessage(AGENT_ID, runId, workerId, 'hi');
      expect(res).toEqual({ ok: false, reason: 'run finalized' });
    });

    it('cancelWorker on a live worker returns {ok:true} and aborts the backend', async () => {
      const { factory, backends } = makeFactory();
      const coord = new SwarmCoordinator({ childDriver: createFakeChildDriver(factory) });
      const a = coord.attach(baseAttach());
      const { workerId } = coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r', brief: 'b' });
      await backends[0].onNextSegment();
      const res = coord.cancelWorker(AGENT_ID, a.runIdHint, workerId);
      expect(res.ok).toBe(true);
      expect(backends[0].abortCalls).toBe(1);
    });
  });

  // Behavior 12: cancelRunsFor / stop.
  describe('cancelRunsFor and stop', () => {
    it('cancelRunsFor finalizes all runs for the agent (consumer-gone)', async () => {
      const { factory, backends } = makeFactory();
      const coord = new SwarmCoordinator({ childDriver: createFakeChildDriver(factory) });
      coord.attach(baseAttach({ conversationId: 'c1' }));
      coord.attach(baseAttach({ conversationId: 'c2' }));
      coord.spawnWorker(AGENT_ID, 'c1', { role: 'r', brief: 'b' });
      coord.spawnWorker(AGENT_ID, 'c2', { role: 'r', brief: 'b' });
      await waitForBackends(backends, 2);
      await backends[0].onNextSegment();
      await backends[1].onNextSegment();
      coord.cancelRunsFor(AGENT_ID);
      expect(backends[0].abortCalls).toBe(1);
      expect(backends[1].abortCalls).toBe(1);
      // Both turns are closed now.
      expect(() => coord.spawnWorker(AGENT_ID, 'c1', { role: 'r', brief: 'b' })).toThrow();
    });

    it('cancelTurn finalizes only the keyed conversation and reports whether one existed', async () => {
      const { factory, backends } = makeFactory();
      const coord = new SwarmCoordinator({ childDriver: createFakeChildDriver(factory) });
      coord.attach(baseAttach({ conversationId: 'c1' }));
      coord.attach(baseAttach({ conversationId: 'c2' }));
      coord.spawnWorker(AGENT_ID, 'c1', { role: 'r', brief: 'b' });
      coord.spawnWorker(AGENT_ID, 'c2', { role: 'r', brief: 'b' });
      await waitForBackends(backends, 2);
      await backends[0].onNextSegment();
      await backends[1].onNextSegment();

      expect(coord.cancelTurn(AGENT_ID, 'c1')).toBe(true);
      // c1's worker aborted; c2 untouched and still spawnable.
      expect(backends[0].abortCalls).toBe(1);
      expect(backends[1].abortCalls).toBe(0);
      expect(() => coord.spawnWorker(AGENT_ID, 'c1', { role: 'r', brief: 'b' })).toThrow();
      expect(() => coord.spawnWorker(AGENT_ID, 'c2', { role: 'r', brief: 'b' })).not.toThrow();
      // Idempotent + accurate return for unknown/finalized turns.
      expect(coord.cancelTurn(AGENT_ID, 'c1')).toBe(false);
      expect(coord.cancelTurn(AGENT_ID, 'nope')).toBe(false);
    });

    it('stop finalizes runs across all agents', async () => {
      const { factory, backends } = makeFactory();
      const coord = new SwarmCoordinator({ childDriver: createFakeChildDriver(factory) });
      coord.attach(baseAttach({ agentId: 'a1', conversationId: 'c1' }));
      coord.attach(baseAttach({ agentId: 'a2', conversationId: 'c2' }));
      coord.spawnWorker('a1', 'c1', { role: 'r', brief: 'b' });
      coord.spawnWorker('a2', 'c2', { role: 'r', brief: 'b' });
      await waitForBackends(backends, 2);
      await backends[0].onNextSegment();
      await backends[1].onNextSegment();
      coord.stop();
      expect(backends[0].abortCalls).toBe(1);
      expect(backends[1].abortCalls).toBe(1);
    });
  });

  // onRunChanged callback.
  describe('onRunChanged', () => {
    it('fires on spawn, worker terminal, and finalize', async () => {
      const { factory, backends } = makeFactory();
      const onRunChanged = vi.fn();
      const coord = new SwarmCoordinator({
        childDriver: createFakeChildDriver(factory),
        onRunChanged,
      });
      const a = coord.attach(baseAttach());
      coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r', brief: 'b' });
      expect(onRunChanged).toHaveBeenCalledWith(AGENT_ID, a.runIdHint);
      onRunChanged.mockClear();
      const seg = await backends[0].onNextSegment();
      seg.complete();
      await new Promise((r) => setTimeout(r, 0));
      expect(onRunChanged).toHaveBeenCalled();
      onRunChanged.mockClear();
      a.finalize({ consumerAlive: true });
      expect(onRunChanged).toHaveBeenCalled();
    });
  });

  // Subagent hook threading: the hooks option handed to the coordinator must
  // reach every child handle — this is the seam the gateway
  // uses to fire the SubagentStart/SubagentStop plugin hook events.
  describe('subagent hooks', () => {
    function makeHookRecorder() {
      const starts: Array<{ workerId: string; role: string }> = [];
      const stops: Array<{ workerId: string; role: string; status: string }> = [];
      return {
        starts,
        stops,
        hooks: {
          subagentStart: (w: { workerId: string; role: string }) => starts.push(w),
          subagentStop: (w: { workerId: string; role: string; status: string }) => stops.push(w),
        },
      };
    }

    it('fires subagentStart on spawn and subagentStop{done} when the worker completes', async () => {
      const { factory, backends } = makeFactory();
      const { starts, stops, hooks } = makeHookRecorder();
      const coord = new SwarmCoordinator({ childDriver: createFakeChildDriver(factory), hooks });
      coord.attach(baseAttach());
      const { workerId } = coord.spawnWorker(AGENT_ID, CONVO_ID, {
        role: 'researcher',
        brief: 'b',
      });
      // start fires synchronously inside spawnWorker (handle.start in register).
      expect(starts).toEqual([{ workerId, role: 'researcher' }]);
      expect(stops).toEqual([]);
      const seg = await backends[0].onNextSegment();
      seg.complete();
      await new Promise((r) => setTimeout(r, 0));
      expect(stops).toEqual([{ workerId, role: 'researcher', status: 'done' }]);
    });

    it('fires subagentStop{cancelled} when finalize cancels a live worker', async () => {
      const { factory, backends } = makeFactory();
      const { stops, hooks } = makeHookRecorder();
      const coord = new SwarmCoordinator({ childDriver: createFakeChildDriver(factory), hooks });
      const a = coord.attach(baseAttach());
      const { workerId } = coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'coder', brief: 'b' });
      await backends[0].onNextSegment();
      a.finalize({ consumerAlive: true });
      expect(stops).toEqual([{ workerId, role: 'coder', status: 'cancelled' }]);
    });

    it('fires subagentStop{failed} when the backend errors', async () => {
      const { starts, stops, hooks } = makeHookRecorder();
      const failingFactory: WorkerFactory = () => Promise.reject(new Error('backend boom'));
      const coord = new SwarmCoordinator({
        childDriver: createFakeChildDriver(failingFactory),
        hooks,
      });
      coord.attach(baseAttach());
      const { workerId } = coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'tester', brief: 'b' });
      expect(starts).toEqual([{ workerId, role: 'tester' }]);
      // Let the rejected backend promise drive finalizeFailed.
      await new Promise((r) => setTimeout(r, 0));
      expect(stops).toEqual([{ workerId, role: 'tester', status: 'failed' }]);
    });
  });

  // sendToWorker (tool-facing).
  describe('sendToWorker', () => {
    it('steers a live worker returning {ok:true}', async () => {
      const { factory, backends } = makeFactory();
      const coord = new SwarmCoordinator({ childDriver: createFakeChildDriver(factory) });
      coord.attach(baseAttach());
      const { workerId } = coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r', brief: 'b' });
      await backends[0].onNextSegment();
      const res = coord.sendToWorker(AGENT_ID, CONVO_ID, { workerId, message: 'also do X' });
      expect(res.ok).toBe(true);
    });
  });

  // Behavior 13: ask_orchestrator threading (the worker-side tool is delivered
  // to the factory in the WorkerSpec, wired to the real handle + run.closed).
  describe('ask_orchestrator threading', () => {
    it('the spec handed to the factory carries exactly one extraTool named ask_orchestrator', () => {
      const { factory, specs } = makeFactory();
      const coord = new SwarmCoordinator({ childDriver: createFakeChildDriver(factory) });
      coord.attach(baseAttach());
      coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r', brief: 'b' });
      expect(specs).toHaveLength(1);
      expect(specs[0].extraTools).toHaveLength(1);
      expect(specs[0].extraTools[0].name).toBe('ask_orchestrator');
    });

    it('end-to-end: worker invokes ask_orchestrator → waiting_input → sendToWorker answer resolves the tool', async () => {
      // A factory whose backend invokes its spec's ask_orchestrator on the first
      // segment and reports the answer it receives back to the test.
      let workerIdSeen = '';
      const askResult = deferred<string>();
      const factory: WorkerFactory = (spec) => {
        const ask = spec.extraTools.find((t) => t.name === 'ask_orchestrator');
        if (!ask) throw new Error('expected an ask_orchestrator tool in the spec');
        workerIdSeen = spec.workerId;
        const backend: WorkerBackend = {
          async *chat(): AsyncGenerator<AgentEvent> {
            const res = await ask.execute('call-1', { question: 'which db?' }, undefined);
            askResult.resolve(res.content[0].text);
            // Block forever after asking; the run finalize will settle teardown.
            await new Promise<void>(() => {});
          },
          abort() {},
          async stop() {},
        };
        return Promise.resolve(backend);
      };

      const coord = new SwarmCoordinator({ childDriver: createFakeChildDriver(factory) });
      coord.attach(baseAttach());
      const { workerId } = coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r', brief: 'b' });

      // Wait until the worker asks and lands in waiting_input.
      const deadline = Date.now() + 1000;
      while (Date.now() < deadline) {
        const run = coord.getLiveRun(AGENT_ID, CONVO_ID);
        const status = run?.getHandle(workerId)?.status;
        if (status === 'waiting_input') break;
        await new Promise((r) => setTimeout(r, 1));
      }
      const run = coord.getLiveRun(AGENT_ID, CONVO_ID);
      expect(run?.getHandle(workerId)?.status).toBe('waiting_input');
      expect(workerIdSeen).toBe(workerId);

      // The orchestrator answers via send_to_worker; the tool resolves with it.
      const sent = coord.sendToWorker(AGENT_ID, CONVO_ID, { workerId, message: 'use postgres' });
      expect(sent.ok).toBe(true);
      expect(await askResult.promise).toBe('use postgres');
    });

    it('run-closed (finalize) aborts a pending ask: the worker is cancelled and the tool rejects', async () => {
      const askError = deferred<unknown>();
      const factory: WorkerFactory = (spec) => {
        const ask = spec.extraTools.find((t) => t.name === 'ask_orchestrator');
        if (!ask) throw new Error('expected an ask_orchestrator tool in the spec');
        const backend: WorkerBackend = {
          async *chat(): AsyncGenerator<AgentEvent> {
            try {
              await ask.execute('call-1', { question: 'blocked?' }, undefined);
              askError.resolve(undefined); // resolved without throwing = failure
            } catch (err) {
              askError.resolve(err);
            }
            // Block after settling; teardown is driven by the run finalize.
            await new Promise<void>(() => {});
          },
          abort() {},
          async stop() {},
        };
        return Promise.resolve(backend);
      };

      const coord = new SwarmCoordinator({ childDriver: createFakeChildDriver(factory) });
      const a = coord.attach(baseAttach());
      const { workerId } = coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r', brief: 'b' });

      // Wait for the worker to reach waiting_input, then finalize the run.
      const deadline = Date.now() + 1000;
      while (Date.now() < deadline) {
        const run = coord.getLiveRun(AGENT_ID, CONVO_ID);
        if (run?.getHandle(workerId)?.status === 'waiting_input') break;
        await new Promise((r) => setTimeout(r, 1));
      }
      a.finalize({ consumerAlive: true }); // fires run.closed → cancels the worker

      const err = await askError.promise;
      expect(err).toBeInstanceOf(Error);
    });
  });

  // A4: named children — subagent_* emission, waitWorker, findWorker, roster.
  describe('named children', () => {
    it('spawnWorker emits subagent_started with the named-child fields', async () => {
      const { coordinator, events } = setupLiveTurn();
      const { workerId } = coordinator.spawnWorker(AGENT_ID, CONVO_ID, {
        role: 'mapper',
        brief: 'map it',
        subagentType: 'Explore',
        description: 'map code',
        name: 'mapper',
      });
      await flush();
      const started = events.find((e) => e.type === 'subagent_started');
      expect(started).toMatchObject({
        subagentId: workerId,
        name: 'mapper',
        subagentType: 'Explore',
        description: 'map code',
        background: false,
        depth: 1,
      });
      expect(started && 'startedAt' in started && started.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(events.some((e) => e.type === 'worker_spawned' && e.workerId === workerId)).toBe(true);
      // The legacy mirror lands first so clients that only decode worker_spawned
      // still create the card before any subagent_* update refers to it.
      const types = events.map((e) => e.type);
      expect(types.indexOf('worker_spawned')).toBeLessThan(types.indexOf('subagent_started'));
    });

    it('spawnWorker threads the new spec fields through to the worker factory', () => {
      const { coordinator, specs } = setupLiveTurn();
      coordinator.spawnWorker(AGENT_ID, CONVO_ID, {
        role: 'r',
        brief: 'b',
        subagentType: 'Plan',
        description: 'plan the work',
        name: 'planner',
        systemPrompt: 'you plan',
        background: true,
        isolation: 'worktree',
        skipMemory: true,
        maxTurns: 4,
        oneShot: true,
      });
      expect(specs[0]).toMatchObject({
        subagentType: 'Plan',
        description: 'plan the work',
        name: 'planner',
        systemPrompt: 'you plan',
        background: true,
        isolation: 'worktree',
        skipMemory: true,
        maxTurns: 4,
        oneShot: true,
      });
    });

    it('waitWorker resolves with the terminal snapshot including toolCallCount', async () => {
      const { coordinator } = setupLiveTurn({
        script: [
          { type: 'tool_use_start', id: 't1', name: 'read' },
          { type: 'response', content: 'report!', usage: { inputTokens: 1, outputTokens: 2 } },
        ],
      });
      const { workerId } = coordinator.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r', brief: 'b' });
      const snap = await coordinator.waitWorker(AGENT_ID, CONVO_ID, workerId);
      expect(snap.status).toBe('done');
      expect(snap.report).toBe('report!');
      expect(snap.toolCallCount).toBe(1);
      // Defaults when the caller names no subagent type / description.
      expect(snap.subagentType).toBe('general-purpose');
      expect(snap.description).toBe('r');
      expect(snap.background).toBe(false);
      expect(snap.oneShot).toBe(false);
    });

    it('waitWorker throws for an unknown worker id', async () => {
      const { coordinator } = setupLiveTurn();
      coordinator.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r', brief: 'b' });
      await expect(coordinator.waitWorker(AGENT_ID, CONVO_ID, 'nope')).rejects.toThrow(
        /unknown worker nope/,
      );
    });

    it('waitWorker ignores waiting_input; wait_workers still returns early', async () => {
      const { factory, backends } = makeFactory();
      const coord = new SwarmCoordinator({ childDriver: createFakeChildDriver(factory) });
      coord.attach(baseAttach());
      const { workerId } = coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r', brief: 'b' });
      const seg = await backends[0].onNextSegment();
      const handle = coord.getLiveRun(AGENT_ID, CONVO_ID)?.getHandle(workerId);
      if (!handle) throw new Error('expected a live handle');

      let settled = false;
      const waitP = coord.waitWorker(AGENT_ID, CONVO_ID, workerId);
      void waitP.then(() => {
        settled = true;
      });
      const askP = handle.waitForQuestion('need input?', undefined, 60_000);
      // Longer than waitWorkers' 5ms poll, so a premature resolve would show up.
      await new Promise((r) => setTimeout(r, 25));
      expect(settled).toBe(false);

      // The public wait_workers behaviour is unchanged: it returns on waiting_input.
      const early = await coord.waitWorkers(AGENT_ID, CONVO_ID, { workerIds: [workerId] });
      expect(early[0].status).toBe('waiting_input');

      handle.answerQuestion('go on');
      await askP;
      await seg.emit({
        type: 'response',
        content: 'finally',
        usage: { inputTokens: 0, outputTokens: 0 },
      });
      seg.complete();
      const snap = await waitP;
      expect(snap.status).toBe('done');
      expect(snap.report).toBe('finally');
    });

    it('findWorker resolves by name then id, latest wins', () => {
      const { coordinator } = setupLiveTurn();
      const a = coordinator.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r', brief: 'b', name: 'dup' });
      const b = coordinator.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r', brief: 'b', name: 'dup' });
      expect(coordinator.findWorker(AGENT_ID, CONVO_ID, 'dup')?.workerId).toBe(b.workerId);
      expect(coordinator.findWorker(AGENT_ID, CONVO_ID, a.workerId)?.workerId).toBe(a.workerId);
      expect(coordinator.findWorker(AGENT_ID, CONVO_ID, 'missing')).toBeUndefined();
    });

    it('findWorker falls back to the latest finalized run of the conversation', async () => {
      const { coordinator, attachment } = setupLiveTurn();
      const { workerId } = coordinator.spawnWorker(AGENT_ID, CONVO_ID, {
        role: 'r',
        brief: 'b',
        name: 'scout',
      });
      await flush();
      attachment.finalize({ consumerAlive: true });
      expect(coordinator.findWorker(AGENT_ID, CONVO_ID, 'scout')?.workerId).toBe(workerId);
      expect(coordinator.findWorker(AGENT_ID, 'other-convo', 'scout')).toBeUndefined();
    });

    it('rosterFor lists id, name, type and status for every worker', () => {
      const { coordinator } = setupLiveTurn();
      const named = coordinator.spawnWorker(AGENT_ID, CONVO_ID, {
        role: 'r',
        brief: 'b',
        name: 'scout',
        subagentType: 'Explore',
      });
      const anon = coordinator.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r2', brief: 'b2' });
      expect(coordinator.rosterFor(AGENT_ID, CONVO_ID)).toEqual([
        { id: named.workerId, name: 'scout', type: 'Explore', status: 'running' },
        { id: anon.workerId, name: undefined, type: 'general-purpose', status: 'running' },
      ]);
      expect(coordinator.rosterFor(AGENT_ID, 'other-convo')).toEqual([]);
    });

    it('subagent_finished is emitted alongside worker_done', async () => {
      const { coordinator, events } = setupLiveTurn({
        script: [{ type: 'response', content: 'r', usage: { inputTokens: 0, outputTokens: 0 } }],
      });
      const { workerId } = coordinator.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r', brief: 'b' });
      await coordinator.waitWorker(AGENT_ID, CONVO_ID, workerId);
      await flush();
      expect(events.find((e) => e.type === 'subagent_finished')).toMatchObject({
        subagentId: workerId,
        status: 'done',
        report: 'r',
        toolCallCount: 0,
      });
      // The legacy mirror lands first, then the richer event.
      const types = events.map((e) => e.type);
      expect(types.indexOf('worker_done')).toBeLessThan(types.indexOf('subagent_finished'));
    });
  });

  // A4 review fixes: retry guard, depth threading, phantom cleanup, history wait.
  describe('named children (review fixes)', () => {
    it('waitWorker returns the snapshot it has when the run closes non-terminal', async () => {
      const { factory, backends } = makeFactory();
      const coord = new SwarmCoordinator({ childDriver: createFakeChildDriver(factory) });
      coord.attach(baseAttach());
      const { workerId } = coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r', brief: 'b' });
      await backends[0].onNextSegment();
      const run = coord.getLiveRun(AGENT_ID, CONVO_ID);
      if (!run) throw new Error('expected a live run');

      const waitP = coord.waitWorker(AGENT_ID, CONVO_ID, workerId);
      // Abort `closed` WITHOUT cancelling the workers. run.finalize/onWallClock
      // happen to cancelAll first today, but nothing enforces that, and an
      // unguarded retry would re-enter on a microtask forever (starving the
      // event loop) because an aborted `closed` settles waitWorkers at once.
      (run as unknown as { closedController: AbortController }).closedController.abort();

      const snap = await waitP;
      expect(snap.workerId).toBe(workerId);
      expect(TERMINAL.has(snap.status)).toBe(false);
    }, 1_000);

    it('threads depth into subagent_started, defaulting to 1', async () => {
      const { coordinator, events } = setupLiveTurn();
      const child = coordinator.spawnWorker(AGENT_ID, CONVO_ID, {
        role: 'grandchild',
        brief: 'b',
        depth: 2,
      });
      const direct = coordinator.spawnWorker(AGENT_ID, CONVO_ID, { role: 'child', brief: 'b' });
      await flush();
      const startedFor = (id: string) =>
        events.find((e) => e.type === 'subagent_started' && e.subagentId === id);
      expect(startedFor(child.workerId)).toMatchObject({ depth: 2 });
      expect(startedFor(direct.workerId)).toMatchObject({ depth: 1 });
    });

    it('terminalizes the phantom card when the run refuses to adopt the child', async () => {
      const { coordinator, events } = setupLiveTurn();
      coordinator.spawnWorker(AGENT_ID, CONVO_ID, { role: 'real', brief: 'b' });
      const run = coordinator.getLiveRun(AGENT_ID, CONVO_ID);
      if (!run) throw new Error('expected a live run');
      run.adopt = () => {
        throw new Error('register exploded');
      };

      expect(() =>
        coordinator.spawnWorker(AGENT_ID, CONVO_ID, {
          role: 'ghost',
          brief: 'b',
          name: 'ghost',
          subagentType: 'Explore',
        }),
      ).toThrow(/register exploded/);
      await flush();

      const spawned = events.find((e) => e.type === 'worker_spawned' && e.role === 'ghost');
      expect(spawned).toBeDefined();
      const ghostId = spawned && 'workerId' in spawned ? spawned.workerId : '';
      expect(events.find((e) => e.type === 'worker_done' && e.workerId === ghostId)).toMatchObject({
        status: 'failed',
        report: 'register exploded',
      });
      expect(
        events.find((e) => e.type === 'subagent_finished' && e.subagentId === ghostId),
      ).toMatchObject({ status: 'failed', name: 'ghost', subagentType: 'Explore' });
    });

    it('waitWorker agrees with findWorker after the turn finalizes', async () => {
      const { coordinator, attachment } = setupLiveTurn();
      const { workerId } = coordinator.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r', brief: 'b' });
      await flush();
      attachment.finalize({ consumerAlive: true });

      const snap = await coordinator.waitWorker(AGENT_ID, CONVO_ID, workerId);
      expect(snap.workerId).toBe(workerId);
      expect(snap.status).toBe('done');
      expect(coordinator.findWorker(AGENT_ID, CONVO_ID, workerId)).toEqual(snap);
      await expect(coordinator.waitWorker(AGENT_ID, CONVO_ID, 'nope')).rejects.toThrow(
        /unknown worker nope/,
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Children as conversations (Task C3). These drive the coordinator through a
// scripted ChildTurnDriver — no worker factory, no backend — which is the
// production shape: the gateway's driver runs a child as a real conversation.
// ---------------------------------------------------------------------------

interface ScriptedChild {
  input: import('./types.js').ChildConversationInput;
  ref: import('./types.js').ChildTurnRef;
  texts: string[];
}

function makeChildDriver() {
  const children = new Map<string, ScriptedChild>();
  const prepared: import('./types.js').ChildSpec[] = [];
  /** Stands in for the gateway's persisted grant: the last spec prepared. */
  const preparedById = new Map<string, import('./types.js').ChildSpec>();
  const persisted: import('./types.js').ChildSnapshot[] = [];
  const deleted = new Set<string>();
  /** Child conversations whose live turn the coordinator asked to abort. */
  const cancelledTurns: string[] = [];
  const eventListeners = new Set<(t: import('./types.js').ChildTurnRef, e: AgentEvent) => void>();
  const finishListeners = new Set<
    (
      t: import('./types.js').ChildTurnRef,
      o: import('./types.js').ChildTurnOutcome,
      error?: string,
    ) => void
  >();
  let seq = 0;

  const driver: import('./types.js').ChildTurnDriver = {
    prepareChild(spec) {
      prepared.push(spec);
      preparedById.set(spec.childConversationId, spec);
    },
    createChild(input) {
      // Idempotent on id, like the real store: a RESUME re-creates the row it
      // already has, and the turn history must survive that.
      const existing = children.get(input.id);
      if (existing) {
        existing.input = input;
        return;
      }
      children.set(input.id, {
        input,
        ref: { agentId: input.agentId, conversationId: input.id, turnId: '' },
        texts: [],
      });
    },
    startTurn({ agentId, conversationId, text }) {
      const child = children.get(conversationId);
      if (!child) throw new Error(`no child ${conversationId}`);
      const turnId = `child-turn-${++seq}`;
      child.ref = { agentId, conversationId, turnId };
      child.texts.push(text);
      return { turnId };
    },
    cancelTurn: (_agentId, conversationId) => {
      cancelledTurns.push(conversationId);
      return Promise.resolve();
    },
    updateChild() {},
    listChildren(parentConversationId) {
      return persisted.filter((c) => c.parentConversationId === parentConversationId);
    },
    isChildAlive: (id) => children.has(id) && !deleted.has(id),
    onEvent(listener) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    onFinish(listener) {
      finishListeners.add(listener);
      return () => finishListeners.delete(listener);
    },
  };

  const ids = () => [...children.keys()];
  return {
    driver,
    children,
    prepared,
    preparedById,
    persisted,
    cancelledTurns,
    ids,
    /** The child created most recently. */
    last: () => children.get(ids()[ids().length - 1] as string) as ScriptedChild,
    emit(id: string, event: AgentEvent) {
      const child = children.get(id);
      if (!child) throw new Error(`no child ${id}`);
      for (const listener of [...eventListeners]) listener(child.ref, event);
    },
    finish(id: string, outcome: import('./types.js').ChildTurnOutcome = 'completed') {
      const child = children.get(id);
      if (!child) throw new Error(`no child ${id}`);
      for (const listener of [...finishListeners]) listener(child.ref, outcome);
    },
    tombstone(id: string) {
      deleted.add(id);
    },
  };
}

const PARENT = { agentId: AGENT_ID, agentName: 'Agent One', conversationId: CONVO_ID };

function setupChildTurn(
  caps?: Partial<import('./types.js').SwarmCaps>,
  opts: { childHeartbeatMs?: number } = {},
) {
  const d = makeChildDriver();
  const coordinator = new SwarmCoordinator({
    childDriver: d.driver,
    defaultCaps: caps,
    // Stands in for the gateway's rebuild-from-the-row: the coordinator drops a
    // finished child's spec, so a resume always goes back to persistence (which
    // is where the grant is re-intersected against the live parent).
    reconstructChildSpec: (id) => {
      // A tombstoned row is NOT resumable, exactly as in the gateway: the
      // rebuild reads a live row or refuses.
      const spec = d.driver.isChildAlive(id) ? d.preparedById.get(id) : undefined;
      if (!spec) return undefined;
      const { extraTools: _extraTools, ...rest } = spec;
      return rest;
    },
    ...opts,
  });
  const attachment = coordinator.attach(baseAttach({ messageId: 'parent-turn-1' }));
  const events: AgentEvent[] = [];
  void (async () => {
    while (true) {
      const r = await attachment.channel.take();
      if (r.done) return;
      events.push(r.value);
    }
  })();
  return { d, coordinator, attachment, events };
}

describe('SwarmCoordinator children as conversations', () => {
  it('spawnChild creates the child conversation and starts a turn with the prompt', () => {
    const { d, coordinator } = setupChildTurn();
    const { subagentId } = coordinator.spawnChild(
      { ...PARENT, turnId: 'parent-turn-1', depth: 0, workspace: '/repo' },
      { role: 'scout', brief: 'survey the repo', description: 'survey repo', name: 'scout' },
    );

    expect(subagentId).toMatch(/^sub_[0-9A-HJKMNP-TV-Z]{26}$/);
    const child = d.children.get(subagentId) as ScriptedChild;
    expect(child.input).toMatchObject({
      id: subagentId,
      agentId: AGENT_ID,
      agentName: 'Agent One',
      parentConversationId: CONVO_ID,
      parentTurnId: 'parent-turn-1',
      subagent: {
        type: 'general-purpose',
        name: 'scout',
        status: 'running',
        description: 'survey repo',
        prompt: 'survey the repo',
        depth: 1,
      },
    });
    expect(child.texts).toEqual(['survey the repo']);
    expect(d.prepared[0]).toMatchObject({
      childConversationId: subagentId,
      parentConversationId: CONVO_ID,
      workspace: '/repo',
    });
  });

  it('the parent channel receives subagent_started, progress and subagent_finished', async () => {
    const { d, coordinator, events } = setupChildTurn();
    const { subagentId } = coordinator.spawnChild(
      { ...PARENT, turnId: 'parent-turn-1', depth: 0 },
      { role: 'scout', brief: 'go', description: 'go' },
    );
    d.emit(subagentId, { type: 'tool_use_start', id: 't1', name: 'read', input: {} });
    d.emit(subagentId, { type: 'tool_use_start', id: 't2', name: 'grep', input: {} });
    d.emit(subagentId, {
      type: 'response',
      content: 'the report',
      usage: { inputTokens: 1, outputTokens: 2 },
    });
    d.finish(subagentId);
    await coordinator.waitChild(subagentId);
    await flush();

    expect(events.find((e) => e.type === 'subagent_started')).toMatchObject({
      subagentId,
      depth: 1,
    });
    // Throttled to 1/s: the second tool call in the same millisecond is dropped.
    const progress = events.filter((e) => e.type === 'subagent_progress');
    expect(progress).toHaveLength(1);
    expect(progress[0]).toMatchObject({ toolCallCount: 1 });
    expect(events.find((e) => e.type === 'subagent_finished')).toMatchObject({
      subagentId,
      status: 'done',
      report: 'the report',
      toolCallCount: 2,
    });
  });

  it('waitChild resolves the terminal snapshot', async () => {
    const { d, coordinator } = setupChildTurn();
    const { subagentId } = coordinator.spawnChild(
      { ...PARENT, turnId: 'parent-turn-1', depth: 0 },
      { role: 'scout', brief: 'go', description: 'go', name: 'scout' },
    );
    setTimeout(() => {
      d.emit(subagentId, {
        type: 'response',
        content: 'found it',
        usage: { inputTokens: 5, outputTokens: 6 },
      });
      d.finish(subagentId);
    }, 1);

    const snap = await coordinator.waitChild(subagentId);
    expect(snap).toMatchObject({
      subagentId,
      name: 'scout',
      status: 'done',
      report: 'found it',
      usage: { inputTokens: 5, outputTokens: 6 },
      depth: 1,
    });
  });

  it('refuses a spawn past maxDepth with "depth limit reached"', () => {
    const { coordinator } = setupChildTurn({ maxDepth: 2 });
    // depth 1 and 2 are inside the ceiling...
    expect(() =>
      coordinator.spawnChild({ ...PARENT, turnId: 't', depth: 1 }, { role: 'a', brief: 'b' }),
    ).not.toThrow();
    // ...depth 3 is not.
    expect(() =>
      coordinator.spawnChild({ ...PARENT, turnId: 't', depth: 2 }, { role: 'a', brief: 'b' }),
    ).toThrow(/depth limit reached/);
  });

  it('maxDepth 0 refuses every spawn — "may not nest at all" is expressible', () => {
    const { coordinator } = setupChildTurn({ maxDepth: 0 });
    expect(() =>
      coordinator.spawnChild({ ...PARENT, turnId: 't', depth: 0 }, { role: 'a', brief: 'b' }),
    ).toThrow(/depth limit reached/);
  });

  it('enforces the per-conversation, per-turn and global caps', () => {
    const { coordinator } = setupChildTurn({ maxConcurrentWorkers: 2, maxWorkersPerRun: 3 });
    const spawn = () =>
      coordinator.spawnChild({ ...PARENT, turnId: 't', depth: 0 }, { role: 'a', brief: 'b' });
    spawn();
    spawn();
    expect(spawn).toThrow(/too many workers running at once \(max 2\)/);

    const global = new SwarmCoordinator({
      childDriver: makeChildDriver().driver,
      globalMaxConcurrentWorkers: 1,
    });
    global.attach(baseAttach());
    global.spawnChild({ ...PARENT, turnId: 't', depth: 0 }, { role: 'a', brief: 'b' });
    expect(() =>
      global.spawnChild({ ...PARENT, turnId: 't', depth: 0 }, { role: 'a', brief: 'b' }),
    ).toThrow(/global worker limit \(1\)/);
  });

  it('cancelChild cascades to a grandchild', async () => {
    const { d, coordinator } = setupChildTurn();
    const { subagentId: childId } = coordinator.spawnChild(
      { ...PARENT, turnId: 'parent-turn-1', depth: 0 },
      { role: 'lead', brief: 'delegate', description: 'delegate' },
    );
    // The child opens a turn on ITS OWN conversation and spawns a grandchild
    // against it — nesting is an ordinary spawn one level down.
    coordinator.attach(baseAttach({ conversationId: childId, messageId: 'child-turn-1' }));
    const { subagentId: grandchildId } = coordinator.spawnChild(
      {
        agentId: AGENT_ID,
        agentName: 'Agent One',
        conversationId: childId,
        turnId: 'child-turn-1',
        depth: 1,
      },
      { role: 'helper', brief: 'help', description: 'help' },
    );

    expect(coordinator.childrenOf(childId).map((c) => c.subagentId)).toEqual([grandchildId]);
    expect(d.children.get(grandchildId)?.input.subagent.depth).toBe(2);

    await coordinator.cancelChild(childId, 'parent cancelled');

    expect(coordinator.findChild(CONVO_ID, childId)?.status).toBe('cancelled');
    expect(coordinator.findChild(childId, grandchildId)?.status).toBe('cancelled');
  });

  it('cancels a child whose conversation was deleted out from under it', async () => {
    const { d, coordinator } = setupChildTurn(undefined, { childHeartbeatMs: 2 });
    const { subagentId } = coordinator.spawnChild(
      { ...PARENT, turnId: 'parent-turn-1', depth: 0 },
      { role: 'scout', brief: 'go', description: 'go' },
    );
    d.tombstone(subagentId);
    // The liveness poll rides the heartbeat (2ms here, 10s in production).
    await vi.waitFor(
      () => {
        expect(coordinator.findChild(CONVO_ID, subagentId)?.status).toBe('cancelled');
      },
      { timeout: 200, interval: 5 },
    );
  });

  it('findChild resolves a child spawned in an EARLIER turn', () => {
    const { d, coordinator, attachment } = setupChildTurn();
    const { subagentId } = coordinator.spawnChild(
      { ...PARENT, turnId: 'parent-turn-1', depth: 0 },
      { role: 'scout', brief: 'go', description: 'go', name: 'scout' },
    );
    d.finish(subagentId);
    attachment.finalize({ consumerAlive: true });

    // Turn two opens a fresh run on the same conversation. The old lookup saw
    // the live run OR history, never both, so `scout` became unaddressable the
    // moment this attach happened.
    coordinator.attach(baseAttach({ messageId: 'parent-turn-2' }));
    coordinator.spawnChild(
      { ...PARENT, turnId: 'parent-turn-2', depth: 0 },
      { role: 'other', brief: 'go', description: 'go' },
    );

    expect(coordinator.findChild(CONVO_ID, 'scout')?.subagentId).toBe(subagentId);
    expect(coordinator.findWorker(AGENT_ID, CONVO_ID, 'scout')?.subagentId).toBe(subagentId);
    expect(coordinator.childrenOf(CONVO_ID)).toHaveLength(2);
  });

  it('childrenOf merges persisted rows this process has no handle for', () => {
    const { d, coordinator } = setupChildTurn();
    d.persisted.push({
      subagentId: 'sub_FROMBEFORERESTART0000000000',
      workerId: 'sub_FROMBEFORERESTART0000000000',
      parentConversationId: CONVO_ID,
      parentTurnId: 'older-turn',
      role: 'ghost',
      status: 'interrupted',
      brief: 'b',
      model: 'm',
      usage: { inputTokens: 0, outputTokens: 0 },
      subagentType: 'general-purpose',
      description: 'ghost',
      name: 'ghost',
      toolCallCount: 0,
      background: true,
      oneShot: false,
      depth: 1,
    });
    coordinator.spawnChild(
      { ...PARENT, turnId: 'parent-turn-1', depth: 0 },
      { role: 'live', brief: 'go', description: 'go', name: 'live' },
    );

    expect(coordinator.childrenOf(CONVO_ID).map((c) => c.name)).toEqual(['ghost', 'live']);
    expect(coordinator.findChild(CONVO_ID, 'ghost')?.status).toBe('interrupted');
  });

  it('spawn_worker maps onto the SAME child lifetime, not a second one', () => {
    const { d, coordinator } = setupChildTurn();
    const { workerId } = coordinator.spawnWorker(AGENT_ID, CONVO_ID, {
      role: 'legacy',
      brief: 'do the legacy thing',
    });

    expect(workerId).toMatch(/^sub_/);
    expect(d.children.get(workerId)?.input.parentTurnId).toBe('parent-turn-1');
    expect(coordinator.childrenOf(CONVO_ID).map((c) => c.subagentId)).toEqual([workerId]);
    expect(coordinator.checkWorkers(AGENT_ID, CONVO_ID)).toMatchObject([
      { workerId, role: 'legacy', status: 'running' },
    ]);
  });
});

describe('SwarmCoordinator registry and roster bounds', () => {
  /** Spawn `n` children on the live turn and drive each to `done`. */
  function spawnAndFinish(
    coordinator: SwarmCoordinator,
    d: ReturnType<typeof makeChildDriver>,
    n: number,
    namePrefix = 'c',
  ): string[] {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const { subagentId } = coordinator.spawnChild(
        { ...PARENT, turnId: 'parent-turn-1', depth: 0 },
        { role: 'r', brief: 'b', description: 'd', name: `${namePrefix}${i}` },
      );
      d.finish(subagentId);
      ids.push(subagentId);
    }
    return ids;
  }

  it('rosterFor keeps every LIVE child but only the most recent terminal ones', () => {
    const { d, coordinator } = setupChildTurn();
    spawnAndFinish(coordinator, d, 15, 'old');
    // Two that never finish. They are the `send_message` targets the roster
    // exists to advertise, so no bound may drop them.
    coordinator.spawnChild(
      { ...PARENT, turnId: 'parent-turn-1', depth: 0 },
      { role: 'r', brief: 'b', description: 'd', name: 'live-a' },
    );
    coordinator.spawnChild(
      { ...PARENT, turnId: 'parent-turn-1', depth: 0 },
      { role: 'r', brief: 'b', description: 'd', name: 'live-b' },
    );

    expect(coordinator.childrenOf(CONVO_ID)).toHaveLength(17);
    const roster = coordinator.rosterFor(AGENT_ID, CONVO_ID);
    // 10 most recent terminal + both live ones — not all 17.
    expect(roster).toHaveLength(12);
    expect(roster.filter((r) => r.status === 'running').map((r) => r.name)).toEqual([
      'live-a',
      'live-b',
    ]);
    expect(roster.map((r) => r.name)).toContain('old14');
    expect(roster.map((r) => r.name)).not.toContain('old0');
  });

  it('forgetConversation drops a deleted conversation, its children and its grandchildren', () => {
    const { d, coordinator } = setupChildTurn();
    const [childId] = spawnAndFinish(coordinator, d, 1, 'child');
    coordinator.attach(baseAttach({ conversationId: childId, messageId: 'child-turn-1' }));
    const { subagentId: grandchildId } = coordinator.spawnChild(
      {
        agentId: AGENT_ID,
        agentName: 'Agent One',
        conversationId: childId,
        turnId: 'child-turn-1',
        depth: 1,
      },
      { role: 'r', brief: 'b', description: 'd', name: 'grandchild' },
    );
    d.finish(grandchildId);
    expect(coordinator.findChild(CONVO_ID, 'child0')).toBeDefined();
    expect(coordinator.findChild(childId, 'grandchild')).toBeDefined();

    // The conversation delete cascaded to both child rows before the
    // coordinator was told to forget them.
    d.tombstone(childId);
    d.tombstone(grandchildId);
    coordinator.forgetConversation(CONVO_ID);

    // The conversation delete cascaded to both rows, so nothing is addressable
    // and nothing is retained.
    expect(coordinator.findChild(CONVO_ID, 'child0')).toBeUndefined();
    expect(coordinator.findChild(childId, 'grandchild')).toBeUndefined();
    expect(coordinator.childSpec(childId)).toBeUndefined();
    expect(coordinator.childSpec(grandchildId)).toBeUndefined();
  });

  it('evicts cold parent buckets across conversations, never a bucket with a live child', () => {
    const d = makeChildDriver();
    const coordinator = new SwarmCoordinator({ childDriver: d.driver });
    // One conversation whose child never finishes, spawned FIRST so it is the
    // oldest bucket and the eviction sweep reaches it first.
    coordinator.attach(baseAttach({ conversationId: 'convo-live' }));
    coordinator.spawnChild(
      { ...PARENT, conversationId: 'convo-live', turnId: 't', depth: 0 },
      { role: 'r', brief: 'b', description: 'd', name: 'never-finishes' },
    );
    // Then 300 conversations that each spawn one child and finish it.
    for (let i = 0; i < 300; i++) {
      const conversationId = `convo-${i}`;
      coordinator.attach(baseAttach({ conversationId }));
      const { subagentId } = coordinator.spawnChild(
        { ...PARENT, conversationId, turnId: 't', depth: 0 },
        { role: 'r', brief: 'b', description: 'd' },
      );
      d.finish(subagentId);
    }

    // Bounded, and the live bucket survived every sweep.
    expect(coordinator.childrenOf('convo-0')).toEqual([]);
    expect(coordinator.childrenOf('convo-live')).toHaveLength(1);
    expect(coordinator.findChild('convo-live', 'never-finishes')?.status).toBe('running');
    expect(coordinator.childrenOf('convo-299')).toHaveLength(1);
  });

  it('a child whose registration fails leaves no phantom in the run', async () => {
    const { d, coordinator, events } = setupChildTurn();
    coordinator.spawnChild(
      { ...PARENT, turnId: 'parent-turn-1', depth: 0 },
      { role: 'real', brief: 'b', description: 'd' },
    );
    const run = coordinator.getLiveRun(AGENT_ID, CONVO_ID);
    if (!run) throw new Error('expected a live run');
    const realCount = run.snapshot().workers.length;
    d.driver.prepareChild = () => {
      throw new Error('driver refused');
    };

    expect(() =>
      coordinator.spawnChild(
        { ...PARENT, turnId: 'parent-turn-1', depth: 0 },
        { role: 'ghost', brief: 'b', description: 'd' },
      ),
    ).toThrow(/driver refused/);

    // The run must not carry a child that never started: it would show up in
    // every snapshot and get a SECOND worker_done from the cancel sweep.
    expect(run.snapshot().workers).toHaveLength(realCount);
    run.finalize('turn over');
    await flush();
    const spawned = events.find((e) => e.type === 'worker_spawned' && e.role === 'ghost');
    const ghostId = spawned && 'workerId' in spawned ? spawned.workerId : '';
    expect(ghostId).toBeTruthy();
    // Exactly one: the phantom's own terminal pair, not a second from the
    // run's cancel sweep finding a child that never started.
    expect(events.filter((e) => e.type === 'worker_done' && e.workerId === ghostId)).toHaveLength(
      1,
    );
  });
});

describe('SwarmCoordinator eviction never loses a live descendant', () => {
  it('keeps a cold parent bucket whose GRANDCHILD is still running', () => {
    const d = makeChildDriver();
    const coordinator = new SwarmCoordinator({ childDriver: d.driver });
    // A terminal child of the oldest conversation, with a grandchild that is
    // still going. Evicting the bucket would drop the grandchild from the
    // global registry: the caps would under-count it and a cancel cascade
    // would never reach it.
    coordinator.attach(baseAttach({ conversationId: 'convo-cold' }));
    const { subagentId: childId } = coordinator.spawnChild(
      { ...PARENT, conversationId: 'convo-cold', turnId: 't', depth: 0 },
      { role: 'r', brief: 'b', description: 'd', name: 'terminal-child' },
    );
    coordinator.attach(baseAttach({ conversationId: childId, messageId: 'child-turn' }));
    const { subagentId: grandchildId } = coordinator.spawnChild(
      {
        agentId: AGENT_ID,
        agentName: 'Agent One',
        conversationId: childId,
        turnId: 'child-turn',
        depth: 1,
      },
      { role: 'r', brief: 'b', description: 'd', name: 'live-grandchild' },
    );
    d.finish(childId);

    for (let i = 0; i < 300; i++) {
      const conversationId = `filler-${i}`;
      coordinator.attach(baseAttach({ conversationId }));
      const { subagentId } = coordinator.spawnChild(
        { ...PARENT, conversationId, turnId: 't', depth: 0 },
        { role: 'r', brief: 'b', description: 'd' },
      );
      d.finish(subagentId);
    }

    expect(coordinator.findChild('convo-cold', 'terminal-child')).toBeDefined();
    expect(coordinator.findChild(childId, 'live-grandchild')?.subagentId).toBe(grandchildId);
    expect(coordinator.activeWorkerCount()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Task C4: a background child outlives the turn that spawned it, a foreground
// one does not, and a finished child is resumable.
// ---------------------------------------------------------------------------

describe('SwarmCoordinator background detachment', () => {
  it('finalize cancels the FOREGROUND child and leaves the background one running', () => {
    const { coordinator, attachment } = setupChildTurn();
    const { subagentId: fg } = coordinator.spawnChild(
      { ...PARENT, turnId: 'parent-turn-1', depth: 0 },
      { role: 'fg', brief: 'b', description: 'd', name: 'fg' },
    );
    const { subagentId: bg } = coordinator.spawnChild(
      { ...PARENT, turnId: 'parent-turn-1', depth: 0 },
      { role: 'bg', brief: 'b', description: 'd', name: 'bg', background: true },
    );

    attachment.finalize({ consumerAlive: true });

    expect(coordinator.findChild(CONVO_ID, fg)?.status).toBe('cancelled');
    expect(coordinator.findChild(CONVO_ID, bg)?.status).toBe('running');
  });

  it('cancelTurn (user cancel / socket close) leaves a background child running', () => {
    const { coordinator } = setupChildTurn();
    const { subagentId: fg } = coordinator.spawnChild(
      { ...PARENT, turnId: 'parent-turn-1', depth: 0 },
      { role: 'fg', brief: 'b', description: 'd' },
    );
    const { subagentId: bg } = coordinator.spawnChild(
      { ...PARENT, turnId: 'parent-turn-1', depth: 0 },
      { role: 'bg', brief: 'b', description: 'd', background: true },
    );

    expect(coordinator.cancelTurn(AGENT_ID, CONVO_ID)).toBe(true);

    expect(coordinator.findChild(CONVO_ID, fg)?.status).toBe('cancelled');
    expect(coordinator.findChild(CONVO_ID, bg)?.status).toBe('running');
    // Still counted against the global ceiling: it is still burning tokens.
    expect(coordinator.activeWorkerCount()).toBe(1);
  });

  it('a detached background child is still bounded by its OWN wall clock', async () => {
    vi.useFakeTimers();
    try {
      const { coordinator, attachment } = setupChildTurn({ maxRunSeconds: 10 });
      const { subagentId } = coordinator.spawnChild(
        { ...PARENT, turnId: 'parent-turn-1', depth: 0 },
        { role: 'bg', brief: 'b', description: 'd', background: true },
      );
      // The turn ends immediately — with a RUN-scoped clock this child would
      // now be unbounded, because finalize clears the run's timer.
      attachment.finalize({ consumerAlive: true });
      expect(coordinator.findChild(CONVO_ID, subagentId)?.status).toBe('running');

      await vi.advanceTimersByTimeAsync(10_000);

      const snap = coordinator.findChild(CONVO_ID, subagentId);
      expect(snap?.status).toBe('cancelled');
      expect(snap?.report).toContain('wall clock');
    } finally {
      vi.useRealTimers();
    }
  });

  it('forgetConversation CANCELS a live descendant rather than silently dropping it', async () => {
    const { d, coordinator } = setupChildTurn();
    const { subagentId } = coordinator.spawnChild(
      { ...PARENT, turnId: 'parent-turn-1', depth: 0 },
      { role: 'bg', brief: 'b', description: 'd', background: true },
    );
    coordinator.attach(baseAttach({ conversationId: subagentId, messageId: 'child-turn-1' }));
    const { subagentId: grandchildId } = coordinator.spawnChild(
      {
        agentId: AGENT_ID,
        agentName: 'Agent One',
        conversationId: subagentId,
        turnId: 'child-turn-1',
        depth: 1,
      },
      { role: 'helper', brief: 'b', description: 'd', background: true },
    );
    expect(coordinator.activeWorkerCount()).toBe(2);

    // The parent conversation was deleted: the cascade tombstoned both rows.
    coordinator.forgetConversation(CONVO_ID);

    // Forgetting the handles WITHOUT cancelling under-counts the global cap and
    // leaves two children running that nothing can reach any more, so both live
    // turns must have been aborted before the registry dropped them.
    expect(d.cancelledTurns).toEqual([grandchildId, subagentId]);
    expect(coordinator.activeWorkerCount()).toBe(0);
    expect(coordinator.findChild(CONVO_ID, subagentId)).toBeUndefined();
    expect(coordinator.findChild(subagentId, grandchildId)).toBeUndefined();
  });

  it('waitWorker resolves a child that is still running from an EARLIER turn', async () => {
    const { d, coordinator, attachment } = setupChildTurn();
    const { subagentId } = coordinator.spawnChild(
      { ...PARENT, turnId: 'parent-turn-1', depth: 0 },
      { role: 'bg', brief: 'b', description: 'd', name: 'bg', background: true },
    );
    attachment.finalize({ consumerAlive: true });
    // Turn two: findChild and checkWorkers both resolve the detached child, so
    // waitWorker must too rather than throwing `unknown worker`.
    coordinator.attach(baseAttach({ messageId: 'parent-turn-2' }));
    expect(coordinator.findChild(CONVO_ID, 'bg')?.status).toBe('running');

    const waitP = coordinator.waitWorker(AGENT_ID, CONVO_ID, subagentId);
    d.emit(subagentId, {
      type: 'response',
      content: 'late report',
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    d.finish(subagentId);

    await expect(waitP).resolves.toMatchObject({ status: 'done', report: 'late report' });
  });
});

describe('SwarmCoordinator sendToChild', () => {
  it('queues a message to a RUNNING child and delivers it as the next turn', async () => {
    const { d, coordinator } = setupChildTurn();
    const { subagentId } = coordinator.spawnChild(
      { ...PARENT, turnId: 'parent-turn-1', depth: 0 },
      { role: 'scout', brief: 'go', description: 'd', name: 'scout' },
    );
    const child = d.children.get(subagentId) as ScriptedChild;

    const res = coordinator.sendToChild(CONVO_ID, 'scout', 'also check the tests');

    expect(res).toEqual({ ok: true, status: 'running', mode: 'queued' });
    // Queued, not started: the child is mid-turn.
    expect(child.texts).toEqual(['go']);
    d.finish(subagentId);
    expect(child.texts).toEqual(['go', 'also check the tests']);
    expect(coordinator.findChild(CONVO_ID, 'scout')?.status).toBe('running');
  });

  it('RESUMES a finished child immediately, with the message as the new turn', async () => {
    const { d, coordinator } = setupChildTurn();
    const { subagentId } = coordinator.spawnChild(
      { ...PARENT, turnId: 'parent-turn-1', depth: 0 },
      { role: 'scout', brief: 'go', description: 'd', name: 'scout' },
    );
    const child = d.children.get(subagentId) as ScriptedChild;
    d.finish(subagentId);
    await coordinator.waitChild(subagentId);
    expect(coordinator.findChild(CONVO_ID, 'scout')?.status).toBe('done');

    const res = coordinator.sendToChild(CONVO_ID, 'scout', 'one more thing');

    expect(res).toEqual({ ok: true, status: 'running', mode: 'resumed' });
    expect(child.texts).toEqual(['go', 'one more thing']);
    expect(coordinator.findChild(CONVO_ID, 'scout')?.status).toBe('running');
    // The resumed child runs the SAME conversation, not a new one — in the
    // registry AND in the run it was re-adopted into.
    expect(coordinator.childrenOf(CONVO_ID)).toHaveLength(1);
    expect(coordinator.getLiveRun(AGENT_ID, CONVO_ID)?.snapshot().workers).toHaveLength(1);
    expect(coordinator.checkWorkers(AGENT_ID, CONVO_ID)).toHaveLength(1);
  });

  it('refuses a one-shot child', () => {
    const { d, coordinator } = setupChildTurn();
    const { subagentId } = coordinator.spawnChild(
      { ...PARENT, turnId: 'parent-turn-1', depth: 0 },
      {
        role: 'Explore',
        brief: 'map',
        description: 'd',
        name: 'mapper',
        subagentType: 'Explore',
        oneShot: true,
      },
    );
    d.finish(subagentId);

    expect(() => coordinator.sendToChild(CONVO_ID, 'mapper', 'again')).toThrow(/one-shot/);
  });

  it('refuses a name it cannot resolve in this conversation', () => {
    const { coordinator } = setupChildTurn();
    expect(() => coordinator.sendToChild(CONVO_ID, 'nobody', 'hi')).toThrow(/No agent named/);
  });

  it('caps steers across a resume (maxSteersPerWorker)', async () => {
    const { d, coordinator } = setupChildTurn({ maxSteersPerWorker: 1 });
    const { subagentId } = coordinator.spawnChild(
      { ...PARENT, turnId: 'parent-turn-1', depth: 0 },
      { role: 'scout', brief: 'go', description: 'd', name: 'scout' },
    );
    expect(coordinator.sendToChild(CONVO_ID, 'scout', 'first steer').mode).toBe('queued');
    d.finish(subagentId); // delivers the steer as turn two
    d.finish(subagentId); // turn two completes → the child is done

    await coordinator.waitChild(subagentId);
    expect(() => coordinator.sendToChild(CONVO_ID, 'scout', 'second steer')).toThrow(/steer cap/);
  });

  it('resumes a child whose in-memory spec is gone, from the reconstructed one', async () => {
    const d = makeChildDriver();
    const rebuilt: string[] = [];
    const coordinator = new SwarmCoordinator({
      childDriver: d.driver,
      reconstructChildSpec: (id) => {
        rebuilt.push(id);
        return {
          agentId: AGENT_ID,
          agentName: 'Agent One',
          runId: 'rebuilt',
          workerId: id,
          childConversationId: id,
          parentConversationId: CONVO_ID,
          parentTurnId: 'older-turn',
          role: 'ghost',
          brief: 'the original brief',
          model: 'orch-model',
          workspace: '/repo',
          tools: ['read'],
          subagentType: 'general-purpose',
          description: 'ghost',
          name: 'ghost',
          depth: 1,
        };
      },
    });
    coordinator.attach(baseAttach({ messageId: 'parent-turn-1' }));
    // A child of a PREVIOUS gateway process: a persisted row, no handle, no spec.
    const ghostId = 'sub_FROMBEFORERESTART0000000000';
    d.persisted.push({
      subagentId: ghostId,
      workerId: ghostId,
      parentConversationId: CONVO_ID,
      parentTurnId: 'older-turn',
      role: 'ghost',
      status: 'done',
      brief: 'the original brief',
      model: 'orch-model',
      usage: { inputTokens: 0, outputTokens: 0 },
      subagentType: 'general-purpose',
      description: 'ghost',
      name: 'ghost',
      toolCallCount: 0,
      background: true,
      oneShot: false,
      depth: 1,
    });

    const res = coordinator.sendToChild(CONVO_ID, 'ghost', 'pick this back up');

    expect(res).toEqual({ ok: true, status: 'running', mode: 'resumed' });
    expect(rebuilt).toEqual([ghostId]);
    expect((d.children.get(ghostId) as ScriptedChild).texts).toEqual(['pick this back up']);
    expect(coordinator.childSpec(ghostId)).toMatchObject({ tools: ['read'], workspace: '/repo' });
  });

  it('refuses to resume a child no spec can be rebuilt for', () => {
    const d = makeChildDriver();
    const coordinator = new SwarmCoordinator({ childDriver: d.driver });
    coordinator.attach(baseAttach({ messageId: 'parent-turn-1' }));
    const ghostId = 'sub_FROMBEFORERESTART0000000000';
    d.persisted.push({
      subagentId: ghostId,
      workerId: ghostId,
      parentConversationId: CONVO_ID,
      parentTurnId: 'older-turn',
      role: 'ghost',
      status: 'done',
      brief: 'b',
      model: 'm',
      usage: { inputTokens: 0, outputTokens: 0 },
      subagentType: 'general-purpose',
      description: 'ghost',
      name: 'ghost',
      toolCallCount: 0,
      background: false,
      oneShot: false,
      depth: 1,
    });

    expect(() => coordinator.sendToChild(CONVO_ID, 'ghost', 'resume')).toThrow(/cannot be resumed/);
  });

  it('childSpec falls back to the reconstructed spec for a spec-less child', () => {
    const d = makeChildDriver();
    const coordinator = new SwarmCoordinator({
      childDriver: d.driver,
      reconstructChildSpec: (id) => ({
        agentId: AGENT_ID,
        agentName: 'Agent One',
        runId: 'rebuilt',
        workerId: id,
        childConversationId: id,
        parentConversationId: CONVO_ID,
        parentTurnId: 'older-turn',
        role: 'ghost',
        brief: 'b',
        model: 'orch-model',
        workspace: '/repo',
        tools: ['read', 'grep'],
        depth: 1,
      }),
    });

    expect(coordinator.childSpec('sub_GONE00000000000000000000')).toMatchObject({
      tools: ['read', 'grep'],
      extraTools: [],
    });
  });
});

describe('SwarmCoordinator C4 review fixes', () => {
  it('wait_workers waits on a DETACHED child from an earlier turn', async () => {
    const { d, coordinator, attachment } = setupChildTurn();
    const { subagentId } = coordinator.spawnChild(
      { ...PARENT, turnId: 'parent-turn-1', depth: 0 },
      { role: 'bg', brief: 'b', description: 'd', name: 'bg', background: true },
    );
    attachment.finalize({ consumerAlive: true });
    // Turn two names the detached child explicitly. Answering `[]` — "nothing
    // to wait for" — is the one answer that is wrong: with notifications not
    // yet wired this is the only polling primitive the model has for it.
    coordinator.attach(baseAttach({ messageId: 'parent-turn-2' }));

    const waitP = coordinator.waitWorkers(AGENT_ID, CONVO_ID, { workerIds: [subagentId] });
    await flush();
    d.emit(subagentId, {
      type: 'response',
      content: 'late report',
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    d.finish(subagentId);

    await expect(waitP).resolves.toMatchObject([
      { workerId: subagentId, status: 'done', report: 'late report' },
    ]);
  });

  it('wait_workers resolves a detached child even before this turn has spawned', async () => {
    const { d, coordinator, attachment } = setupChildTurn();
    const { subagentId } = coordinator.spawnChild(
      { ...PARENT, turnId: 'parent-turn-1', depth: 0 },
      { role: 'bg', brief: 'b', description: 'd', background: true },
    );
    d.finish(subagentId);
    attachment.finalize({ consumerAlive: true });
    // Turn two has no run at all (nothing spawned in it yet).
    coordinator.attach(baseAttach({ messageId: 'parent-turn-2' }));

    await expect(
      coordinator.waitWorkers(AGENT_ID, CONVO_ID, { workerIds: [subagentId] }),
    ).resolves.toMatchObject([{ workerId: subagentId, status: 'done' }]);
  });

  it('a resume with no live parent turn still uses the AGENT-configured caps', async () => {
    const d = makeChildDriver();
    const coordinator = new SwarmCoordinator({
      childDriver: d.driver,
      // The per-agent `subagents.max*` an attachment would have carried.
      resolveCaps: () => ({ maxSteersPerWorker: 1 }),
      reconstructChildSpec: (id) => {
        const spec = d.preparedById.get(id);
        if (!spec) return undefined;
        const { extraTools: _extraTools, ...rest } = spec;
        return rest;
      },
    });
    const attachment = coordinator.attach(
      baseAttach({ messageId: 'parent-turn-1', caps: { maxSteersPerWorker: 1 } }),
    );
    const { subagentId } = coordinator.spawnChild(
      { ...PARENT, turnId: 'parent-turn-1', depth: 0 },
      { role: 'scout', brief: 'go', description: 'd', name: 'scout' },
    );
    coordinator.sendToChild(CONVO_ID, 'scout', 'first steer');
    d.finish(subagentId);
    d.finish(subagentId);
    await coordinator.waitChild(subagentId);
    // The turn that spawned it is over, so the caps can only come from the
    // agent — the hard defaults would allow ten more steers.
    attachment.finalize({ consumerAlive: true });

    expect(() => coordinator.sendToChild(CONVO_ID, 'scout', 'second steer')).toThrow(/steer cap/);
  });
});

describe('SwarmCoordinator cross-conversation scoping', () => {
  /**
   * Round 2 observation: the registry is global (a child id is unique) but a
   * READ of it is not — naming another conversation's child must not hand back
   * its status or its report, however addressable that child is in this
   * process. `findChild` and `checkWorkers` scope through `childrenOf`; these
   * two now do too.
   */
  function twoConversations() {
    const d = makeChildDriver();
    const coordinator = new SwarmCoordinator({ childDriver: d.driver });
    coordinator.attach(baseAttach({ conversationId: 'convo-a', messageId: 'a-1' }));
    const { subagentId: theirs } = coordinator.spawnChild(
      { ...PARENT, conversationId: 'convo-a', turnId: 'a-1', depth: 0 },
      { role: 'theirs', brief: 'b', description: 'd', name: 'theirs' },
    );
    coordinator.attach(baseAttach({ conversationId: 'convo-b', messageId: 'b-1' }));
    coordinator.spawnChild(
      { ...PARENT, conversationId: 'convo-b', turnId: 'b-1', depth: 0 },
      { role: 'mine', brief: 'b', description: 'd', name: 'mine' },
    );
    return { d, coordinator, theirs };
  }

  it('wait_workers does not resolve another conversation child by id', async () => {
    const { coordinator, theirs } = twoConversations();
    await expect(
      coordinator.waitWorkers(AGENT_ID, 'convo-b', { workerIds: [theirs] }),
    ).resolves.toEqual([]);
  });

  it('waitWorker does not resolve another conversation child by id', async () => {
    const { coordinator, theirs } = twoConversations();
    await expect(coordinator.waitWorker(AGENT_ID, 'convo-b', theirs)).rejects.toThrow(
      /unknown worker/,
    );
  });
});
