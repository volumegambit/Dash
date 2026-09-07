import type { AgentEvent } from '@dash/agent';
import { CanonicalSwarmJournalError, SwarmCoordinator } from './coordinator.js';
import type { AttachOptions } from './coordinator.js';
import type {
  SwarmEventLogSink,
  SwarmJournalIdentity,
  WorkerBackend,
  WorkerFactory,
  WorkerSpec,
} from './types.js';

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
  /** Set to true to make stop() hang forever for settlement-barrier tests. */
  hangStop = false;
  /** Optional deterministic teardown rejection for multi-failure tests. */
  stopError?: unknown;
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
    if (this.stopError !== undefined) throw this.stopError;
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
    identity: SwarmJournalIdentity;
    payload: { type: 'event'; event: AgentEvent };
  }> = [];
  const sink: SwarmEventLogSink = {
    append(agentId, conversationId, identity, payload) {
      appends.push({ agentId, conversationId, identity, payload });
      return Promise.resolve();
    },
  };
  return { sink, appends };
}

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

describe('SwarmCoordinator', () => {
  // Behavior 1: ownership.
  describe('ownership', () => {
    it('a second attach on a live key is non-authoritative (dead channel, aborted closed, no-op finalize)', async () => {
      const { factory } = makeFactory();
      const coord = new SwarmCoordinator({ workerFactory: factory });
      const a = coord.attach(baseAttach());
      const b = coord.attach(baseAttach());

      expect(a.live).toBe(true);
      expect(b.live).toBe(false);
      expect(b.closed.aborted).toBe(true);
      // b's channel is dead: a push is a no-op / take reports done.
      b.channel.push({ type: 'text_delta', text: 'x' });
      // finalize on b must not throw and must not affect a.
      await expect(b.finalize({ consumerAlive: true })).resolves.toBeUndefined();
      expect(a.live).toBe(true);
    });

    it("second attach's finalize does not cancel the first attachment's workers; spawn still routes to A", async () => {
      const { factory, backends } = makeFactory();
      const coord = new SwarmCoordinator({ workerFactory: factory });
      const a = coord.attach(baseAttach());
      coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r', brief: 'b' });
      await backends[0].onNextSegment();

      const b = coord.attach(baseAttach());
      await b.finalize({ consumerAlive: false }); // stale token: must be a no-op

      expect(backends[0].abortCalls).toBe(0);
      // A's run is still live: another spawn succeeds and routes to A.
      const spawned = coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r2', brief: 'b2' });
      expect(spawned.status).toBe('spawning');
      const runs = coord.getRuns(AGENT_ID);
      expect(runs).toHaveLength(1);
      expect(runs[0].runId).toBe(a.runIdHint);
    });
  });

  // Behavior 2: lazy run + closed-turn refusal.
  describe('lazy run creation', () => {
    it('first spawnWorker creates the run under the live attachment', () => {
      const { factory } = makeFactory();
      const coord = new SwarmCoordinator({ workerFactory: factory });
      coord.attach(baseAttach());
      expect(coord.getRuns(AGENT_ID)).toHaveLength(0);
      coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r', brief: 'b' });
      expect(coord.getRuns(AGENT_ID)).toHaveLength(1);
    });

    it('spawnWorker throws "swarm turn is closed" when there is no live attachment', () => {
      const { factory } = makeFactory();
      const coord = new SwarmCoordinator({ workerFactory: factory });
      expect(() => coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r', brief: 'b' })).toThrow(
        /swarm turn is closed/,
      );
      // No orphan run was created.
      expect(coord.getRuns(AGENT_ID)).toHaveLength(0);
    });

    it('spawnWorker throws after the attachment is finalized (no zombie run)', async () => {
      const { factory } = makeFactory();
      const coord = new SwarmCoordinator({ workerFactory: factory });
      const a = coord.attach(baseAttach());
      await a.finalize({ consumerAlive: true });
      expect(() => coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r', brief: 'b' })).toThrow(
        /swarm turn is closed/,
      );
    });
  });

  // Behavior 3: gate re-read.
  describe('gate re-read', () => {
    it('throws when the agent gate reports disabled', () => {
      const { factory } = makeFactory();
      const coord = new SwarmCoordinator({ workerFactory: factory });
      coord.attach(baseAttach({ getAgentGate: () => ({ enabled: true, disabled: true }) }));
      expect(() => coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r', brief: 'b' })).toThrow();
    });

    it('throws when the agent gate reports not enabled', () => {
      const { factory } = makeFactory();
      const coord = new SwarmCoordinator({ workerFactory: factory });
      coord.attach(baseAttach({ getAgentGate: () => ({ enabled: false, disabled: false }) }));
      expect(() => coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r', brief: 'b' })).toThrow();
    });

    it('allows when the gate is enabled and not disabled', () => {
      const { factory } = makeFactory();
      const coord = new SwarmCoordinator({ workerFactory: factory });
      coord.attach(baseAttach({ getAgentGate: () => ({ enabled: true, disabled: false }) }));
      expect(() => coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r', brief: 'b' })).not.toThrow();
    });
  });

  // Behavior 4: caps.
  describe('caps', () => {
    it('throws at maxWorkersPerRun (total), message includes the cap', async () => {
      const { factory, backends } = makeFactory();
      const coord = new SwarmCoordinator({
        workerFactory: factory,
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
        workerFactory: factory,
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
        workerFactory: factory,
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
      const coord = new SwarmCoordinator({ workerFactory: factory });
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
      const coord = new SwarmCoordinator({ workerFactory: factory });
      coord.attach(baseAttach());
      expect(() =>
        coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r', brief: 'b', tools: ['read', 'grep'] }),
      ).not.toThrow();
    });

    it('rejects a tool the orchestrator itself does not have', () => {
      const { factory } = makeFactory();
      const coord = new SwarmCoordinator({ workerFactory: factory });
      coord.attach(baseAttach({ orchestratorTools: ['read', 'grep'] }));
      expect(() =>
        coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r', brief: 'b', tools: ['bash'] }),
      ).toThrow(/bash/);
    });

    it('rejects mcp-prefixed, _skill-suffixed, and unknown tools naming the offender', () => {
      const { factory } = makeFactory();
      const coord = new SwarmCoordinator({ workerFactory: factory });
      coord.attach(baseAttach({ orchestratorTools: undefined }));
      expect(() =>
        coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r', brief: 'b', tools: ['mcp__x'] }),
      ).toThrow(/mcp__x/);
      expect(() =>
        coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r', brief: 'b', tools: ['foo_skill'] }),
      ).toThrow(/foo_skill/);
      expect(() =>
        coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r', brief: 'b', tools: ['wat'] }),
      ).toThrow(/wat/);
    });

    it('uses the default subset when tools is omitted', () => {
      const { factory, specs } = makeFactory();
      const coord = new SwarmCoordinator({ workerFactory: factory });
      coord.attach(baseAttach());
      coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r', brief: 'b' });
      expect(specs[0].tools).toEqual(['read', 'grep', 'find', 'ls']);
    });
  });

  // Behavior 7: sync registration.
  describe('sync registration', () => {
    it('emits worker_spawned + agent_spawned synchronously before any await', () => {
      const { factory } = makeFactory();
      const coord = new SwarmCoordinator({ workerFactory: factory });
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
      const coord = new SwarmCoordinator({ workerFactory: factory });
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
      const coord = new SwarmCoordinator({ workerFactory: factory });
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
      const coord = new SwarmCoordinator({ workerFactory: factory });
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
        const coord = new SwarmCoordinator({ workerFactory: factory });
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
      const coord = new SwarmCoordinator({ workerFactory: factory });
      const a = coord.attach(baseAttach());
      const { workerId } = coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r', brief: 'b' });
      await backends[0].onNextSegment();
      const waitP = coord.waitWorkers(AGENT_ID, CONVO_ID, { workerIds: [workerId] });
      await a.finalize({ consumerAlive: false });
      const res = await waitP;
      expect(res).toHaveLength(1);
    });

    it('throws Error("aborted") when the passed signal aborts', async () => {
      const { factory, backends } = makeFactory();
      const coord = new SwarmCoordinator({ workerFactory: factory });
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
          workerFactory: factory,
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
    it('is idempotent and only effective from the owning attachment', async () => {
      const { factory } = makeFactory();
      const orchestratorAbort = vi.fn();
      const coord = new SwarmCoordinator({ workerFactory: factory });
      const a = coord.attach(baseAttach({ orchestratorAbort }));
      coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r', brief: 'b' });
      await a.finalize({ consumerAlive: true });
      await a.finalize({ consumerAlive: true });
      expect(orchestratorAbort).toHaveBeenCalledTimes(1);
    });

    it('pushes worker_done{cancelled} to the channel before closing it (consumerAlive)', async () => {
      const { factory, backends } = makeFactory();
      const coord = new SwarmCoordinator({ workerFactory: factory });
      const a = coord.attach(baseAttach());
      coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r', brief: 'b' });
      await backends[0].onNextSegment();
      await a.finalize({ consumerAlive: true });
      const events = await drain(a.channel);
      const done = events.find((e) => e.type === 'worker_done');
      expect(done).toMatchObject({ type: 'worker_done', status: 'cancelled' });
    });

    it('changes state synchronously but waits for backend stop settlement', async () => {
      const { factory, backends } = makeFactory();
      const coord = new SwarmCoordinator({ workerFactory: factory });
      const a = coord.attach(baseAttach());
      coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r', brief: 'b' });
      await backends[0].onNextSegment();
      const stop = deferred<void>();
      vi.spyOn(backends[0], 'stop').mockImplementation(() => stop.promise);
      let settled = false;
      const finalizing = a.finalize({ consumerAlive: true }).then(() => {
        settled = true;
      });
      expect(a.live).toBe(false);
      expect(backends[0].abortCalls).toBe(1);
      await Promise.resolve();
      expect(settled).toBe(false);
      stop.resolve(undefined);
      await finalizing;
    });

    it('appends terminal worker_done to the eventLog ONLY on consumer-gone finalize', async () => {
      const { factory, backends } = makeFactory();
      const { sink, appends } = makeEventLog();
      const coord = new SwarmCoordinator({ workerFactory: factory, eventLog: sink });
      const a = coord.attach(baseAttach({ messageId: 'm-1' }));
      coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r', brief: 'b' });
      await backends[0].onNextSegment();
      await a.finalize({ consumerAlive: false });
      expect(appends.length).toBeGreaterThanOrEqual(1);
      expect(appends[0]).toMatchObject({
        agentId: AGENT_ID,
        conversationId: CONVO_ID,
        identity: { kind: 'legacy', messageId: 'm-1' },
        payload: { type: 'event', event: { type: 'worker_done' } },
      });
    });

    it('does not re-append a worker_done that already rode the live stream (completed before WS cancel)', async () => {
      const { factory, backends } = makeFactory();
      const { sink, appends } = makeEventLog();
      const coord = new SwarmCoordinator({ workerFactory: factory, eventLog: sink });
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

      await expect(coord.cancelTurn(AGENT_ID, CONVO_ID)).resolves.toBe(true);

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
      const coord = new SwarmCoordinator({ workerFactory: factory, eventLog: sink });
      const a = coord.attach(baseAttach({ messageId: 'm-1' }));
      coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r', brief: 'b' });
      await backends[0].onNextSegment();
      await a.finalize({ consumerAlive: true });
      expect(appends).toHaveLength(0);
    });

    it('does not append on consumer-gone finalize when no messageId is set', async () => {
      const { factory, backends } = makeFactory();
      const { sink, appends } = makeEventLog();
      const coord = new SwarmCoordinator({ workerFactory: factory, eventLog: sink });
      const a = coord.attach(baseAttach()); // no messageId
      coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r', brief: 'b' });
      await backends[0].onNextSegment();
      await a.finalize({ consumerAlive: false });
      expect(appends).toHaveLength(0);
    });

    it('clears the live attachment synchronously so subsequent spawn throws', async () => {
      const { factory } = makeFactory();
      const coord = new SwarmCoordinator({ workerFactory: factory });
      const a = coord.attach(baseAttach());
      coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r', brief: 'b' });
      const finalizing = a.finalize({ consumerAlive: true });
      expect(() => coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r', brief: 'b' })).toThrow(
        /swarm turn is closed/,
      );
      await finalizing;
    });
  });

  // Ring buffer retention.
  describe('ring buffer', () => {
    it('retains the last 20 runs per agent; the 21st run evicts the 1st', async () => {
      const { factory } = makeFactory();
      const coord = new SwarmCoordinator({ workerFactory: factory });
      const runIds: string[] = [];
      for (let i = 0; i < 21; i++) {
        const a = coord.attach(baseAttach({ conversationId: `c-${i}` }));
        runIds.push(a.runIdHint);
        coord.spawnWorker(AGENT_ID, `c-${i}`, { role: 'r', brief: 'b' });
        await a.finalize({ consumerAlive: true });
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
          },
        ],
      };
    }

    it('a restored snapshot is listed by getRuns and retrievable by getRun', () => {
      const { factory } = makeFactory();
      const coord = new SwarmCoordinator({ workerFactory: factory });

      coord.restoreFinalizedRun(restoredSnapshot());

      const runs = coord.getRuns(AGENT_ID);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ runId: 'crashed-run', finalized: true, workerCount: 1 });
      const snap = coord.getRun(AGENT_ID, 'crashed-run');
      expect(snap?.workers[0]).toMatchObject({ workerId: 'w-1', status: 'cancelled' });
    });

    it('restored snapshots count toward the per-agent ring buffer cap', () => {
      const { factory } = makeFactory();
      const coord = new SwarmCoordinator({ workerFactory: factory });
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
      const coord = new SwarmCoordinator({ workerFactory: factory });
      const a = coord.attach(baseAttach());
      const { workerId } = coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r', brief: 'b' });
      const seg = await backends[0].onNextSegment();
      seg.complete();
      await new Promise((r) => setTimeout(r, 0));
      const res = await coord.cancelWorker(AGENT_ID, a.runIdHint, workerId);
      expect(res).toEqual({ ok: false, reason: 'worker terminal' });
    });

    it('sendPanelMessage on a finalized run returns {ok:false, reason:"run finalized"}', async () => {
      const { factory } = makeFactory();
      const coord = new SwarmCoordinator({ workerFactory: factory });
      const a = coord.attach(baseAttach());
      const { workerId } = coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r', brief: 'b' });
      const runId = a.runIdHint;
      await a.finalize({ consumerAlive: true });
      const res = coord.sendPanelMessage(AGENT_ID, runId, workerId, 'hi');
      expect(res).toEqual({ ok: false, reason: 'run finalized' });
    });

    it('cancelWorker on a live worker returns {ok:true} and aborts the backend', async () => {
      const { factory, backends } = makeFactory();
      const coord = new SwarmCoordinator({ workerFactory: factory });
      const a = coord.attach(baseAttach());
      const { workerId } = coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r', brief: 'b' });
      await backends[0].onNextSegment();
      const res = await coord.cancelWorker(AGENT_ID, a.runIdHint, workerId);
      expect(res.ok).toBe(true);
      expect(backends[0].abortCalls).toBe(1);
    });
  });

  // Behavior 12: cancelRunsFor / stop.
  describe('cancelRunsFor and stop', () => {
    it('cancelRunsFor finalizes all runs for the agent (consumer-gone)', async () => {
      const { factory, backends } = makeFactory();
      const coord = new SwarmCoordinator({ workerFactory: factory });
      coord.attach(baseAttach({ conversationId: 'c1' }));
      coord.attach(baseAttach({ conversationId: 'c2' }));
      coord.spawnWorker(AGENT_ID, 'c1', { role: 'r', brief: 'b' });
      coord.spawnWorker(AGENT_ID, 'c2', { role: 'r', brief: 'b' });
      await waitForBackends(backends, 2);
      await backends[0].onNextSegment();
      await backends[1].onNextSegment();
      await coord.cancelRunsFor(AGENT_ID);
      expect(backends[0].abortCalls).toBe(1);
      expect(backends[1].abortCalls).toBe(1);
      // Both turns are closed now.
      expect(() => coord.spawnWorker(AGENT_ID, 'c1', { role: 'r', brief: 'b' })).toThrow();
    });

    it('cancelTurn finalizes only the keyed conversation and reports whether one existed', async () => {
      const { factory, backends } = makeFactory();
      const coord = new SwarmCoordinator({ workerFactory: factory });
      coord.attach(baseAttach({ conversationId: 'c1' }));
      coord.attach(baseAttach({ conversationId: 'c2' }));
      coord.spawnWorker(AGENT_ID, 'c1', { role: 'r', brief: 'b' });
      coord.spawnWorker(AGENT_ID, 'c2', { role: 'r', brief: 'b' });
      await waitForBackends(backends, 2);
      await backends[0].onNextSegment();
      await backends[1].onNextSegment();

      await expect(coord.cancelTurn(AGENT_ID, 'c1')).resolves.toBe(true);
      // c1's worker aborted; c2 untouched and still spawnable.
      expect(backends[0].abortCalls).toBe(1);
      expect(backends[1].abortCalls).toBe(0);
      expect(() => coord.spawnWorker(AGENT_ID, 'c1', { role: 'r', brief: 'b' })).toThrow();
      expect(() => coord.spawnWorker(AGENT_ID, 'c2', { role: 'r', brief: 'b' })).not.toThrow();
      // Idempotent + accurate return for unknown/finalized turns.
      await expect(coord.cancelTurn(AGENT_ID, 'c1')).resolves.toBe(false);
      await expect(coord.cancelTurn(AGENT_ID, 'nope')).resolves.toBe(false);
    });

    it('stop finalizes runs across all agents', async () => {
      const { factory, backends } = makeFactory();
      const coord = new SwarmCoordinator({ workerFactory: factory });
      coord.attach(baseAttach({ agentId: 'a1', conversationId: 'c1' }));
      coord.attach(baseAttach({ agentId: 'a2', conversationId: 'c2' }));
      coord.spawnWorker('a1', 'c1', { role: 'r', brief: 'b' });
      coord.spawnWorker('a2', 'c2', { role: 'r', brief: 'b' });
      await waitForBackends(backends, 2);
      await backends[0].onNextSegment();
      await backends[1].onNextSegment();
      await coord.stop();
      expect(backends[0].abortCalls).toBe(1);
      expect(backends[1].abortCalls).toBe(1);
    });
  });

  // onRunChanged callback.
  describe('onRunChanged', () => {
    it('fires on spawn, worker terminal, and finalize', async () => {
      const { factory, backends } = makeFactory();
      const onRunChanged = vi.fn();
      const coord = new SwarmCoordinator({ workerFactory: factory, onRunChanged });
      const a = coord.attach(baseAttach());
      coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r', brief: 'b' });
      expect(onRunChanged).toHaveBeenCalledWith(AGENT_ID, a.runIdHint);
      onRunChanged.mockClear();
      const seg = await backends[0].onNextSegment();
      seg.complete();
      await new Promise((r) => setTimeout(r, 0));
      expect(onRunChanged).toHaveBeenCalled();
      onRunChanged.mockClear();
      await a.finalize({ consumerAlive: true });
      expect(onRunChanged).toHaveBeenCalled();
    });
  });

  // Subagent hook threading: the hooks option handed to the coordinator must
  // reach every WorkerHandle (via run.register) — this is the seam the gateway
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
      const coord = new SwarmCoordinator({ workerFactory: factory, hooks });
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
      const coord = new SwarmCoordinator({ workerFactory: factory, hooks });
      const a = coord.attach(baseAttach());
      const { workerId } = coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'coder', brief: 'b' });
      await backends[0].onNextSegment();
      await a.finalize({ consumerAlive: true });
      expect(stops).toEqual([{ workerId, role: 'coder', status: 'cancelled' }]);
    });

    it('fires subagentStop{failed} when the backend errors', async () => {
      const { starts, stops, hooks } = makeHookRecorder();
      const failingFactory: WorkerFactory = () => Promise.reject(new Error('backend boom'));
      const coord = new SwarmCoordinator({ workerFactory: failingFactory, hooks });
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
      const coord = new SwarmCoordinator({ workerFactory: factory });
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
      const coord = new SwarmCoordinator({ workerFactory: factory });
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

      const coord = new SwarmCoordinator({ workerFactory: factory });
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

      const coord = new SwarmCoordinator({ workerFactory: factory });
      const a = coord.attach(baseAttach());
      const { workerId } = coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r', brief: 'b' });

      // Wait for the worker to reach waiting_input, then finalize the run.
      const deadline = Date.now() + 1000;
      while (Date.now() < deadline) {
        const run = coord.getLiveRun(AGENT_ID, CONVO_ID);
        if (run?.getHandle(workerId)?.status === 'waiting_input') break;
        await new Promise((r) => setTimeout(r, 1));
      }
      await a.finalize({ consumerAlive: true }); // fires run.closed → cancels the worker

      const err = await askError.promise;
      expect(err).toBeInstanceOf(Error);
    });
  });
});

describe('SwarmCoordinator lifecycle settlement', () => {
  it('awaits canonical consumer-gone journal writes and keeps outerRunId distinct', async () => {
    const { factory, backends } = makeFactory();
    const write = deferred<unknown>();
    const append = vi.fn(
      (
        _agentId: string,
        _conversationId: string,
        _identity: SwarmJournalIdentity,
        _payload: { type: 'event'; event: AgentEvent },
      ) => write.promise,
    );
    const coord = new SwarmCoordinator({ workerFactory: factory, eventLog: { append } });
    const attachment = coord.attach(baseAttach({ outerRunId: 'outer-run-1' }));
    coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r', brief: 'b' });
    await backends[0].onNextSegment();

    let settled = false;
    const finalizing = attachment.finalize({ consumerAlive: false }).then(() => {
      settled = true;
    });
    expect(attachment.live).toBe(false);
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(append).toHaveBeenCalledWith(
      AGENT_ID,
      CONVO_ID,
      { kind: 'canonical', outerRunId: 'outer-run-1' },
      expect.objectContaining({ type: 'event' }),
    );

    write.resolve({});
    await finalizing;
    expect(settled).toBe(true);
  });

  it.each([null, new Error('dual journal failed')])(
    'surfaces canonical journal failure %s instead of falling back to a legacy append',
    async (failure) => {
      const { factory, backends } = makeFactory();
      const append = vi.fn(
        (
          _agentId: string,
          _conversationId: string,
          _identity: SwarmJournalIdentity,
          _payload: { type: 'event'; event: AgentEvent },
        ) => (failure instanceof Error ? Promise.reject(failure) : Promise.resolve(failure)),
      );
      const coord = new SwarmCoordinator({ workerFactory: factory, eventLog: { append } });
      const attachment = coord.attach(
        baseAttach({ outerRunId: 'outer-run-1', messageId: 'legacy-message-1' }),
      );
      coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r', brief: 'b' });
      await backends[0].onNextSegment();

      await expect(attachment.finalize({ consumerAlive: false })).rejects.toThrow(
        'canonical swarm journal',
      );
      expect(append).toHaveBeenCalledTimes(1);
      expect(append.mock.calls[0]?.[2]).toEqual({
        kind: 'canonical',
        outerRunId: 'outer-run-1',
      });
    },
  );

  it('preserves a canonical journal failure when worker disposal rejects first', async () => {
    const { factory, backends } = makeFactory();
    const append = vi.fn().mockRejectedValue(new Error('journal unavailable'));
    const coord = new SwarmCoordinator({ workerFactory: factory, eventLog: { append } });
    const attachment = coord.attach(baseAttach({ outerRunId: 'outer-run-1' }));
    coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r', brief: 'b' });
    await backends[0].onNextSegment();
    backends[0].stopError = new Error('worker disposal failed first');

    await expect(attachment.finalize({ consumerAlive: false })).rejects.toBeInstanceOf(
      CanonicalSwarmJournalError,
    );
    expect(backends[0].stopCalls).toBe(1);
    expect(append).toHaveBeenCalledOnce();
  });

  it('stops a worker factory result completed under a retired admission generation', async () => {
    const factoryResult = deferred<WorkerBackend>();
    let generation = 0;
    const coord = new SwarmCoordinator({
      workerFactory: () => factoryResult.promise,
      admission: {
        capture: (agentId, conversationId) => ({ agentId, conversationId, generation }),
        isCurrent: (token) => (token as { generation: number }).generation === generation,
      },
    });
    coord.attach(baseAttach());
    const { workerId } = coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r', brief: 'b' });
    generation++;
    const backend = new FakeBackend();
    factoryResult.resolve(backend);

    const deadline = Date.now() + 1_000;
    while (backend.stopCalls === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(backend.stopCalls).toBe(1);
    expect(backend.segments).toHaveLength(0);
    expect(coord.getLiveRun(AGENT_ID, CONVO_ID)?.getHandle(workerId)?.status).toBe('failed');
  });

  it('keeps a pre-fence attachment stale after re-enable and permits a fresh attachment', async () => {
    const generations = new Map<string, number>();
    const { factory } = makeFactory();
    const coord = new SwarmCoordinator({
      workerFactory: factory,
      admission: {
        capture: (agentId, conversationId) => ({
          agentId,
          conversationId,
          generation: generations.get(agentId) ?? 0,
        }),
        isCurrent: (token) => {
          const captured = token as { agentId: string; generation: number };
          return captured.generation === (generations.get(captured.agentId) ?? 0);
        },
      },
    });
    const stale = coord.attach(baseAttach());

    generations.set(AGENT_ID, 1); // disable
    generations.set(AGENT_ID, 2); // re-enable must not revive the captured token
    expect(() =>
      coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'stale', brief: 'must reject' }),
    ).toThrow(/admission|retired|closed/);
    await stale.finalize({ consumerAlive: true });

    const fresh = coord.attach(baseAttach());
    expect(fresh.live).toBe(true);
    expect(() =>
      coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'fresh', brief: 'allowed' }),
    ).not.toThrow();
    await fresh.finalize({ consumerAlive: true });
  });

  it('retires a pending agent worker while an unaffected sibling still starts', async () => {
    const pendingA = deferred<WorkerBackend>();
    const generations = new Map<string, number>();
    const backendA = new FakeBackend();
    const backendB = new FakeBackend();
    const coord = new SwarmCoordinator({
      workerFactory: (spec) =>
        spec.agentId === 'agent-a' ? pendingA.promise : Promise.resolve(backendB),
      admission: {
        capture: (agentId, conversationId) => ({
          agentId,
          conversationId,
          generation: generations.get(agentId) ?? 0,
        }),
        isCurrent: (token) => {
          const captured = token as { agentId: string; generation: number };
          return captured.generation === (generations.get(captured.agentId) ?? 0);
        },
      },
    });
    coord.attach(baseAttach({ agentId: 'agent-a', conversationId: 'conversation-a' }));
    coord.attach(baseAttach({ agentId: 'agent-b', conversationId: 'conversation-b' }));
    coord.spawnWorker('agent-a', 'conversation-a', { role: 'a', brief: 'pending' });
    coord.spawnWorker('agent-b', 'conversation-b', { role: 'b', brief: 'healthy' });
    generations.set('agent-a', 1);
    const cancellingA = coord.cancelRunsFor('agent-a');
    pendingA.resolve(backendA);

    await cancellingA;
    expect(backendA.stopCalls).toBe(1);
    expect(backendA.segments).toHaveLength(0);
    expect((await backendB.onNextSegment()).message).toBe('healthy');
    expect(() =>
      coord.spawnWorker('agent-b', 'conversation-b', { role: 'b2', brief: 'still healthy' }),
    ).not.toThrow();
    await coord.stop();
  });

  it('settles every pending worker disposal after a process fence when one stop rejects', async () => {
    const pendingA = deferred<WorkerBackend>();
    const pendingB = deferred<WorkerBackend>();
    let processGeneration = 0;
    const stopA = vi.fn(async () => {
      throw new Error('worker a stop failed');
    });
    const stopB = vi.fn(async () => {});
    const makeLateBackend = (stop: () => Promise<void>): WorkerBackend => ({
      async *chat(): AsyncGenerator<AgentEvent> {
        yield { type: 'text_delta', text: 'must not run' };
      },
      abort: vi.fn(),
      stop,
    });
    const coord = new SwarmCoordinator({
      workerFactory: (spec) => (spec.agentId === 'agent-a' ? pendingA.promise : pendingB.promise),
      admission: {
        capture: (agentId, conversationId) => ({
          agentId,
          conversationId,
          processGeneration,
        }),
        isCurrent: (token) =>
          (token as { processGeneration: number }).processGeneration === processGeneration,
      },
    });
    const attachmentA = coord.attach(
      baseAttach({ agentId: 'agent-a', conversationId: 'conversation-a' }),
    );
    const attachmentB = coord.attach(
      baseAttach({ agentId: 'agent-b', conversationId: 'conversation-b' }),
    );
    coord.spawnWorker('agent-a', 'conversation-a', { role: 'a', brief: 'pending a' });
    coord.spawnWorker('agent-b', 'conversation-b', { role: 'b', brief: 'pending b' });

    processGeneration++;
    const stopping = coord.stop();
    expect(attachmentA.live).toBe(false);
    expect(attachmentB.live).toBe(false);
    pendingA.resolve(makeLateBackend(stopA));
    pendingB.resolve(makeLateBackend(stopB));

    await expect(stopping).rejects.toThrow('worker a stop failed');
    expect(stopA).toHaveBeenCalledOnce();
    expect(stopB).toHaveBeenCalledOnce();
  });

  it.each(['cancelRunsFor', 'stop'] as const)(
    '%s joins a matching finalization after its run left the live map',
    async (operation) => {
      const { factory, backends } = makeFactory();
      const coord = new SwarmCoordinator({ workerFactory: factory });
      const attachment = coord.attach(baseAttach());
      coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'r', brief: 'b' });
      await backends[0].onNextSegment();
      const stop = deferred<void>();
      vi.spyOn(backends[0], 'stop').mockImplementation(() => stop.promise);

      const firstFinalization = attachment.finalize({ consumerAlive: true });
      let joinedSettled = false;
      const joined = (operation === 'stop' ? coord.stop() : coord.cancelRunsFor(AGENT_ID)).finally(
        () => {
          joinedSettled = true;
        },
      );
      const firstAssertion = expect(firstFinalization).rejects.toThrow('late stop failed');
      const joinedAssertion = expect(joined).rejects.toThrow('late stop failed');

      await Promise.resolve();
      const settledWhileHeld = joinedSettled;
      stop.reject(new Error('late stop failed'));

      await firstAssertion;
      await joinedAssertion;
      expect(settledWhileHeld).toBe(false);
    },
  );

  it('contains one worker abort throw, terminalizes later workers, disposes all, then rejects', async () => {
    const { factory, backends } = makeFactory();
    const coord = new SwarmCoordinator({ workerFactory: factory });
    const attachment = coord.attach(baseAttach());
    coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'first', brief: 'a' });
    coord.spawnWorker(AGENT_ID, CONVO_ID, { role: 'second', brief: 'b' });
    await waitForBackends(backends, 2);
    await backends[0].onNextSegment();
    await backends[1].onNextSegment();
    backends[0].abort = vi.fn(() => {
      throw new Error('first abort failed');
    });

    const stopping = coord.stop();

    expect(attachment.live).toBe(false);
    expect(backends[1].abortCalls).toBe(1);
    expect(backends[0].stopCalls).toBe(1);
    expect(backends[1].stopCalls).toBe(1);
    const events = await drain(attachment.channel);
    expect(events.filter((event) => event.type === 'worker_done')).toHaveLength(2);
    await expect(stopping).rejects.toThrow('first abort failed');
  });
});
