import type { AgentEvent } from '@dash/agent';
import type { WorkerBackend } from './types.js';
import { WorkerHandle, type WorkerHandleOptions } from './worker-handle.js';

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
 * A scripted fake WorkerBackend. Each call to chat() creates a "segment" whose
 * async generator is driven step-by-step: the test pushes events and completes
 * the segment on demand via the returned controller, giving precise control over
 * interleaving (including the enqueue-vs-completion race).
 */
interface SegmentController {
  message: string;
  /** Emit one AgentEvent from this segment's generator. */
  emit(event: AgentEvent): Promise<void>;
  /** Complete the generator (for-await loop exits). */
  complete(): void;
}

class FakeBackend implements WorkerBackend {
  segments: SegmentController[] = [];
  abortCalls = 0;
  stopCalls = 0;
  /** Resolves once stop() is allowed to settle; kept pending to prove cancel never awaits. */
  stopGate = deferred<void>();
  /** Set to true to make stop() hang forever (proves cancel does not await it). */
  hangStop = false;
  /** Resolves each time a new segment (chat call) begins. */
  private segmentStarted: Array<(c: SegmentController) => void> = [];

  onNextSegment(): Promise<SegmentController> {
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
        // Give the consumer a microtask turn to process the event.
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
      // Never resolves — proves cancel() does not await stop().
      await new Promise<void>(() => {});
      return;
    }
    await this.stopGate.promise;
  }
}

const RUN_ID = 'run-1';
const WORKER_ID = 'w-1';
const ROLE = 'researcher';

function makeHandle(overrides: Partial<WorkerHandleOptions> = {}) {
  const events: AgentEvent[] = [];
  const backend = new FakeBackend();
  const terminals: WorkerHandle[] = [];
  const starts: Array<{ workerId: string; role: string }> = [];
  const stops: Array<{ workerId: string; role: string; status: string }> = [];

  const opts: WorkerHandleOptions = {
    spec: {
      agentId: 'agent-1',
      agentName: 'Agent One',
      runId: RUN_ID,
      workerId: WORKER_ID,
      role: ROLE,
      brief: 'do the thing',
      model: 'test-model',
      workspace: '/tmp/ws',
      tools: [],
    },
    backendPromise: Promise.resolve(backend),
    emit: (event) => events.push(event),
    maxSteers: 3,
    onTerminal: (h) => terminals.push(h),
    hooks: {
      subagentStart: (w) => starts.push(w),
      subagentStop: (w) => stops.push(w),
    },
    ...overrides,
  };
  const handle = new WorkerHandle(opts);
  return { handle, backend, events, terminals, starts, stops };
}

function response(content: string, inputTokens = 0, outputTokens = 0): AgentEvent {
  return { type: 'response', content, usage: { inputTokens, outputTokens } };
}

describe('WorkerHandle', () => {
  it('starts in spawning status', () => {
    const { handle } = makeHandle();
    expect(handle.status).toBe('spawning');
  });

  it('sends the brief as the first segment message', async () => {
    const { handle, backend } = makeHandle();
    handle.start();
    const seg = await backend.onNextSegment();
    expect(seg.message).toBe('do the thing');
    expect(handle.status).toBe('running');
  });

  // Requirement 2: usage accumulation + last response as report + terminal 'done'.
  it('accumulates usage and captures the last response as the report on done', async () => {
    const { handle, backend, events, terminals } = makeHandle();
    handle.start();
    const seg = await backend.onNextSegment();
    await seg.emit(response('partial', 5, 10));
    await seg.emit(response('final report', 3, 7));
    seg.complete();
    await handle.terminalPromise;

    expect(handle.status).toBe('done');
    expect(handle.report).toBe('final report');
    expect(handle.usage).toEqual({ inputTokens: 8, outputTokens: 17 });
    expect(terminals).toHaveLength(1);
    const done = events.find((e) => e.type === 'worker_done');
    expect(done).toMatchObject({
      type: 'worker_done',
      workerId: WORKER_ID,
      runId: RUN_ID,
      role: ROLE,
      status: 'done',
      report: 'final report',
    });
  });

  // Requirement 2: terminal error event -> status 'failed' with error message as report.
  it('transitions to failed with the error message when a terminal error event arrives', async () => {
    const { handle, backend, events } = makeHandle();
    handle.start();
    const seg = await backend.onNextSegment();
    await seg.emit({ type: 'error', error: new Error('boom') });
    seg.complete();
    await handle.terminalPromise;

    expect(handle.status).toBe('failed');
    expect(handle.report).toBe('boom');
    const done = events.find((e) => e.type === 'worker_done');
    expect(done).toMatchObject({ type: 'worker_done', status: 'failed', report: 'boom' });
  });

  // Requirement 3: steer delivered between segments.
  it('delivers a queued steer as the next segment message', async () => {
    const { handle, backend } = makeHandle();
    handle.start();
    const seg1 = await backend.onNextSegment();
    await seg1.emit(response('seg1 done', 1, 1));
    // Steer arrives mid-segment-1.
    const res = handle.send('please also check X');
    expect(res.ok).toBe(true);
    expect(handle.steersUsed).toBe(1);
    seg1.complete();

    const seg2 = await backend.onNextSegment();
    expect(seg2.message).toBe('please also check X');
    expect(handle.status).toBe('running');
  });

  // Requirement 3: the enqueue-vs-completion race. send() called in the same
  // synchronous turn the last event resolves must either deliver or return
  // ok:false — never silently drop after returning ok:true.
  it('never silently drops a steer in the enqueue-vs-completion race', async () => {
    const { handle, backend } = makeHandle();
    handle.start();
    const seg1 = await backend.onNextSegment();
    await seg1.emit(response('seg1', 1, 1));
    seg1.complete();
    // Steer in the very next synchronous turn, before awaiting anything.
    const res = handle.send('race steer');

    if (res.ok) {
      // Delivered: a second segment must run with this message.
      const seg2 = await backend.onNextSegment();
      expect(seg2.message).toBe('race steer');
    } else {
      // Rejected as terminal: worker must actually be terminal, steer not applied.
      expect(res.reason).toBe('worker terminal');
      await handle.terminalPromise;
      expect(['done', 'failed', 'cancelled']).toContain(handle.status);
    }
  });

  // Requirement 4: send() on a terminal worker.
  it('rejects send() on a terminal worker', async () => {
    const { handle, backend } = makeHandle();
    handle.start();
    const seg = await backend.onNextSegment();
    await seg.emit(response('done', 1, 1));
    seg.complete();
    await handle.terminalPromise;

    const res = handle.send('too late');
    expect(res).toEqual({ ok: false, reason: 'worker terminal' });
  });

  // Requirement 4: steer cap.
  it('rejects steers past maxSteers with steer cap reached', async () => {
    const { handle, backend } = makeHandle({ maxSteers: 2 });
    handle.start();
    let seg = await backend.onNextSegment();
    await seg.emit(response('a', 1, 1));

    expect(handle.send('steer 1')).toEqual({ ok: true });
    // Deliver steer 1 as segment 2.
    seg.complete();
    seg = await backend.onNextSegment();
    expect(seg.message).toBe('steer 1');
    await seg.emit(response('b', 1, 1));
    expect(handle.send('steer 2')).toEqual({ ok: true });
    // steer 3 exceeds the cap of 2.
    expect(handle.send('steer 3')).toEqual({ ok: false, reason: 'steer cap reached' });
    expect(handle.steersUsed).toBe(2);
  });

  // Requirement 5: question flow — waitForQuestion emits waiting_input, send resolves it.
  it('resolves waitForQuestion when send() answers the question', async () => {
    const { handle, backend, events } = makeHandle();
    handle.start();
    await backend.onNextSegment();

    const qp = handle.waitForQuestion('proceed?', undefined, 10_000);
    expect(handle.status).toBe('waiting_input');
    expect(handle.pendingQuestion).toBe('proceed?');
    const waiting = events.find((e) => e.type === 'worker_status' && e.status === 'waiting_input');
    expect(waiting).toMatchObject({ status: 'waiting_input', question: 'proceed?' });

    const res = handle.send('yes, proceed');
    expect(res).toEqual({ ok: true });
    await expect(qp).resolves.toBe('yes, proceed');
    expect(handle.status).toBe('running');
    expect(handle.pendingQuestion).toBeUndefined();
  });

  // Requirement 5: question timeout rejects.
  it('rejects waitForQuestion on timeout', async () => {
    vi.useFakeTimers();
    try {
      const { handle, backend } = makeHandle();
      handle.start();
      await backend.onNextSegment();
      const qp = handle.waitForQuestion('slow?', undefined, 5_000);
      const assertion = expect(qp).rejects.toThrow(/timeout/i);
      await vi.advanceTimersByTimeAsync(5_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  // Requirement 5: abort signal rejects the question waiter.
  it('rejects waitForQuestion when the signal aborts', async () => {
    const { handle, backend } = makeHandle();
    handle.start();
    await backend.onNextSegment();
    const ac = new AbortController();
    const qp = handle.waitForQuestion('abort me?', ac.signal, 10_000);
    const assertion = expect(qp).rejects.toBeDefined();
    ac.abort();
    await assertion;
  });

  // Requirement 5 + 7: cancel() during waiting_input rejects the waiter immediately
  // WITHOUT awaiting the backend (stop hangs forever).
  it('cancel() during waiting_input rejects the waiter without awaiting the backend', async () => {
    const { handle, backend, events, terminals } = makeHandle();
    backend.hangStop = true; // stop() never resolves
    handle.start();
    await backend.onNextSegment();
    const qp = handle.waitForQuestion('proceed?', undefined, 10_000);
    const assertion = expect(qp).rejects.toBeDefined();

    handle.cancel('user cancelled');

    await assertion; // resolves promptly even though stop() hangs
    expect(handle.status).toBe('cancelled');
    expect(backend.abortCalls).toBe(1);
    expect(backend.stopCalls).toBe(1);
    expect(terminals).toHaveLength(1);
    const done = events.find((e) => e.type === 'worker_done');
    expect(done).toMatchObject({
      type: 'worker_done',
      status: 'cancelled',
      report: 'user cancelled',
    });
  });

  // Requirement 7: cancel() is idempotent.
  it('cancel() is idempotent', async () => {
    const { handle, backend, events, terminals } = makeHandle();
    handle.start();
    await backend.onNextSegment();
    handle.cancel('once');
    handle.cancel('twice');
    expect(terminals).toHaveLength(1);
    expect(backend.abortCalls).toBe(1);
    expect(events.filter((e) => e.type === 'worker_done')).toHaveLength(1);
  });

  // Requirement 7: cancel() before the backend is constructed still works and
  // does not call abort() on a not-yet-constructed backend.
  it('cancel() before backend construction does not abort but still finalizes', async () => {
    const gate = deferred<WorkerBackend>();
    const { handle, events, terminals } = makeHandle({ backendPromise: gate.promise });
    handle.start();
    handle.cancel('early');
    expect(handle.status).toBe('cancelled');
    expect(terminals).toHaveLength(1);
    const done = events.find((e) => e.type === 'worker_done');
    expect(done).toMatchObject({ type: 'worker_done', status: 'cancelled' });
    // Backend resolves later — must not be started/looped after cancel.
    const backend = new FakeBackend();
    gate.resolve(backend);
    await Promise.resolve();
    await Promise.resolve();
    expect(backend.segments).toHaveLength(0);
  });

  // Requirement 6: heartbeat emission under fake timers.
  it('emits worker_status running heartbeats while running', async () => {
    vi.useFakeTimers();
    try {
      const { handle, backend, events } = makeHandle({ heartbeatMs: 1_000 });
      handle.start();
      await backend.onNextSegment();
      events.length = 0; // clear the initial running status
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(1_000);
      const beats = events.filter((e) => e.type === 'worker_status' && e.status === 'running');
      expect(beats.length).toBeGreaterThanOrEqual(2);
      expect(beats[0]).toMatchObject({ status: 'running', workerId: WORKER_ID, runId: RUN_ID });
      expect(beats[0] && 'detail' in beats[0] && beats[0].detail).toMatch(/elapsed/i);
    } finally {
      vi.useRealTimers();
    }
  });

  // Requirement 6: heartbeat cleared on terminal.
  it('stops heartbeats after the worker is terminal', async () => {
    vi.useFakeTimers();
    try {
      const { handle, backend, events } = makeHandle({ heartbeatMs: 1_000 });
      handle.start();
      const seg = await backend.onNextSegment();
      await seg.emit(response('r', 1, 1));
      seg.complete();
      await vi.advanceTimersByTimeAsync(0);
      events.length = 0;
      await vi.advanceTimersByTimeAsync(5_000);
      const beats = events.filter((e) => e.type === 'worker_status' && e.status === 'running');
      expect(beats).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  // Requirement 9: hooks — subagentStart on segment 1, subagentStop on terminal.
  it('fires subagentStart on segment 1 and subagentStop on terminal with final status', async () => {
    const { handle, backend, starts, stops } = makeHandle();
    handle.start();
    const seg = await backend.onNextSegment();
    expect(starts).toEqual([{ workerId: WORKER_ID, role: ROLE }]);
    expect(stops).toHaveLength(0);
    await seg.emit(response('r', 1, 1));
    seg.complete();
    await handle.terminalPromise;
    expect(stops).toEqual([{ workerId: WORKER_ID, role: ROLE, status: 'done' }]);
  });

  // Requirement 8: handle never emits worker_spawned; all events carry ids.
  it('never emits worker_spawned and always tags events with worker/run/role', async () => {
    const { handle, backend, events } = makeHandle();
    handle.start();
    const seg = await backend.onNextSegment();
    await seg.emit(response('r', 1, 1));
    seg.complete();
    await handle.terminalPromise;
    expect(events.some((e) => e.type === 'worker_spawned')).toBe(false);
    for (const e of events) {
      if (e.type === 'worker_status' || e.type === 'worker_done') {
        expect(e.workerId).toBe(WORKER_ID);
        expect(e.runId).toBe(RUN_ID);
        expect(e.role).toBe(ROLE);
      }
    }
  });

  // snapshot() returns a coherent view including startedAt and endedAt on terminal.
  it('snapshot reflects lifecycle including startedAt and endedAt', async () => {
    const { handle, backend } = makeHandle();
    const before = handle.snapshot();
    expect(before.status).toBe('spawning');
    expect(before.endedAt).toBeUndefined();

    handle.start();
    const seg = await backend.onNextSegment();
    await seg.emit(response('final', 2, 3));
    seg.complete();
    await handle.terminalPromise;

    const after = handle.snapshot();
    expect(after).toMatchObject({
      workerId: WORKER_ID,
      role: ROLE,
      status: 'done',
      brief: 'do the thing',
      model: 'test-model',
      report: 'final',
      usage: { inputTokens: 2, outputTokens: 3 },
    });
    expect(typeof after.startedAt).toBe('number');
    expect(typeof after.endedAt).toBe('number');
  });

  // answerQuestion returns false when no question is pending.
  it('answerQuestion returns false when nothing is waiting', async () => {
    const { handle, backend } = makeHandle();
    handle.start();
    await backend.onNextSegment();
    expect(handle.answerQuestion('nobody asked')).toBe(false);
  });
});
