import type { AgentEvent } from '@dash/agent';
import type { WorkerBackend, WorkerSpec } from './types.js';
import { WorkerHandle, type WorkerHandleOptions, legacyWorkerDoneStatus } from './worker-handle.js';

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
  /** Where the child actually ran; set when isolation gave it its own worktree. */
  workspace?: string;
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

  // Final-review fix (a): a timed-out ask must NOT strand the worker in
  // 'waiting_input'. Status returns to 'running' (with a worker_status{running}
  // emitted); when the segment then completes the worker finalizes 'done' with
  // its REAL report — not a cancel/timeout reason.
  it('restores running on ask timeout, then finalizes done with the report intact', async () => {
    vi.useFakeTimers();
    try {
      const { handle, backend, events } = makeHandle();
      handle.start();
      const seg = await backend.onNextSegment();
      // The worker produced its report before asking.
      await seg.emit(response('the real report', 2, 3));

      const qp = handle.waitForQuestion('proceed?', undefined, 5_000);
      expect(handle.status).toBe('waiting_input');
      const assertion = expect(qp).rejects.toThrow(/timeout/i);
      await vi.advanceTimersByTimeAsync(5_000);
      await assertion;

      // Restored to running, and a worker_status{running} was emitted AFTER the
      // waiting_input one.
      expect(handle.status).toBe('running');
      const statuses = events
        .filter((e) => e.type === 'worker_status')
        .map((e) => (e as { status: string }).status);
      expect(statuses).toContain('waiting_input');
      expect(statuses.lastIndexOf('running')).toBeGreaterThan(statuses.indexOf('waiting_input'));
      expect(handle.pendingQuestion).toBeUndefined();

      // Segment completes now → terminal transition must go to 'done' with the
      // real report, NOT stay stuck in waiting_input and NOT report a cancel reason.
      seg.complete();
      await handle.terminalPromise;
      expect(handle.status).toBe('done');
      expect(handle.report).toBe('the real report');
      const done = events.find((e) => e.type === 'worker_done');
      expect(done).toMatchObject({
        type: 'worker_done',
        status: 'done',
        report: 'the real report',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  // Final-review fix (b): a PRE-ABORTED signal clears the pending question and
  // restores 'running' — no waiting_input stranding, and the segment can finalize.
  it('clears the question and restores running when the signal is already aborted', async () => {
    const { handle, backend, events } = makeHandle();
    handle.start();
    const seg = await backend.onNextSegment();
    await seg.emit(response('report after preabort', 1, 1));

    const ac = new AbortController();
    ac.abort(); // already aborted before the ask
    const qp = handle.waitForQuestion('proceed?', ac.signal, 10_000);
    await expect(qp).rejects.toThrow(/aborted/i);

    // No stranding: pending question cleared, status back to running.
    expect(handle.pendingQuestion).toBeUndefined();
    expect(handle.status).toBe('running');

    // Segment completes → done, not stuck in waiting_input.
    seg.complete();
    await handle.terminalPromise;
    expect(handle.status).toBe('done');
    expect(handle.report).toBe('report after preabort');
    const done = events.find((e) => e.type === 'worker_done');
    expect(done).toMatchObject({ type: 'worker_done', status: 'done' });
  });

  // Final-review fix (c): cancel() during waiting_input still wins — the worker
  // terminalizes as 'cancelled' and is NOT resurrected to 'running'.
  it('cancel() during waiting_input wins over the restore (stays cancelled)', async () => {
    const { handle, backend, events } = makeHandle();
    handle.start();
    await backend.onNextSegment();
    const qp = handle.waitForQuestion('proceed?', undefined, 10_000);
    const assertion = expect(qp).rejects.toBeDefined();

    handle.cancel('user cancelled');
    await assertion;

    expect(handle.status).toBe('cancelled');
    // No worker_status{running} was emitted by the cancel path.
    const done = events.find((e) => e.type === 'worker_done');
    expect(done).toMatchObject({
      type: 'worker_done',
      status: 'cancelled',
      report: 'user cancelled',
    });
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

  // A4: subagent_* emission, tool-call counting, and the legacy status mirror.
  describe('subagent_* emission', () => {
    it('emits subagent_started with the spec fields, depth 1 and an ISO startedAt', () => {
      const { handle, events } = makeHandle({
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
          subagentType: 'Explore',
          description: 'map the code',
          name: 'mapper',
          background: true,
          isolation: 'worktree',
        },
      });
      handle.start();
      const started = events.find((e) => e.type === 'subagent_started');
      expect(started).toMatchObject({
        subagentId: WORKER_ID,
        name: 'mapper',
        subagentType: 'Explore',
        description: 'map the code',
        prompt: 'do the thing',
        model: 'test-model',
        background: true,
        isolation: 'worktree',
        depth: 1,
      });
      expect(started && 'startedAt' in started && started.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('defaults subagentType to general-purpose and description to the role', () => {
      const { handle, events } = makeHandle();
      handle.start();
      expect(events.find((e) => e.type === 'subagent_started')).toMatchObject({
        subagentType: 'general-purpose',
        description: ROLE,
        background: false,
        depth: 1,
      });
      expect(handle.snapshot()).toMatchObject({
        subagentType: 'general-purpose',
        description: ROLE,
        toolCallCount: 0,
        background: false,
        oneShot: false,
      });
    });

    it('counts tool_use_start events into toolCallCount and reports it on finish', async () => {
      const { handle, backend, events } = makeHandle();
      handle.start();
      const seg = await backend.onNextSegment();
      await seg.emit({ type: 'tool_use_start', id: 't1', name: 'read' });
      await seg.emit({ type: 'tool_use_start', id: 't2', name: 'grep' });
      await seg.emit(response('final', 1, 2));
      seg.complete();
      await handle.terminalPromise;

      expect(handle.toolCallCount).toBe(2);
      expect(handle.snapshot().toolCallCount).toBe(2);
      const finished = events.find((e) => e.type === 'subagent_finished');
      expect(finished).toMatchObject({
        subagentId: WORKER_ID,
        subagentType: 'general-purpose',
        description: ROLE,
        status: 'done',
        report: 'final',
        toolCallCount: 2,
        usage: { inputTokens: 1, outputTokens: 2 },
      });
      expect(finished && 'endedAt' in finished && finished.endedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      // The legacy mirror still leads so old decoders see worker_done first.
      const types = events.map((e) => e.type);
      expect(types.indexOf('worker_done')).toBeLessThan(types.indexOf('subagent_finished'));
    });

    it('emits subagent_progress on the heartbeat alongside worker_status', async () => {
      vi.useFakeTimers();
      try {
        const { handle, backend, events } = makeHandle({ heartbeatMs: 1_000 });
        handle.start();
        const seg = await backend.onNextSegment();
        await seg.emit({ type: 'tool_use_start', id: 't1', name: 'read' });
        events.length = 0;
        await vi.advanceTimersByTimeAsync(1_000);
        const beats = events.filter((e) => e.type === 'subagent_progress');
        expect(beats.length).toBeGreaterThanOrEqual(1);
        expect(beats[0]).toMatchObject({
          subagentId: WORKER_ID,
          status: 'running',
          toolCallCount: 1,
        });
        expect(beats[0] && 'elapsedMs' in beats[0] && typeof beats[0].elapsedMs).toBe('number');
      } finally {
        vi.useRealTimers();
      }
    });

    it('emits subagent_progress with the question on waiting_input', async () => {
      const { handle, backend, events } = makeHandle();
      handle.start();
      await backend.onNextSegment();
      events.length = 0;
      const asked = handle.waitForQuestion('which file?', undefined, 60_000);
      const waiting = events.find((e) => e.type === 'subagent_progress');
      expect(waiting).toMatchObject({
        subagentId: WORKER_ID,
        status: 'waiting_input',
        question: 'which file?',
      });
      handle.answerQuestion('this one');
      await asked;
      const back = events.filter((e) => e.type === 'subagent_progress');
      expect(back[back.length - 1]).toMatchObject({ status: 'running' });
    });

    it('emits subagent_finished{cancelled} after worker_done on cancel', async () => {
      const { handle, backend, events } = makeHandle();
      handle.start();
      await backend.onNextSegment();
      handle.cancel('user cancelled');
      const finished = events.find((e) => e.type === 'subagent_finished');
      expect(finished).toMatchObject({
        subagentId: WORKER_ID,
        status: 'cancelled',
        report: 'user cancelled',
      });
    });

    it('emits subagent_finished{failed} after worker_done on failure', async () => {
      const { handle, backend, events } = makeHandle();
      handle.start();
      const seg = await backend.onNextSegment();
      await seg.emit({ type: 'error', error: new Error('boom') });
      await handle.terminalPromise;
      expect(events.find((e) => e.type === 'subagent_finished')).toMatchObject({
        status: 'failed',
        report: 'boom',
      });
    });
  });

  describe('legacyWorkerDoneStatus', () => {
    it('passes the three statuses the iOS / Mission Control decoders understand', () => {
      expect(legacyWorkerDoneStatus('done')).toBe('done');
      expect(legacyWorkerDoneStatus('failed')).toBe('failed');
      expect(legacyWorkerDoneStatus('cancelled')).toBe('cancelled');
    });

    it('maps the newer terminal statuses onto failed for legacy decoders', () => {
      expect(legacyWorkerDoneStatus('interrupted')).toBe('failed');
      expect(legacyWorkerDoneStatus('max_turns')).toBe('failed');
    });
  });
});

/**
 * Ruling 5: worktree cleanup is wired to `onFinished`, so the hook has to fire
 * on EVERY terminal path — a cancelled child that skipped it would leave a
 * directory behind on every cancel.
 */
describe('WorkerHandle onFinished', () => {
  function finishing() {
    const specs: Array<Omit<WorkerSpec, 'extraTools'>> = [];
    const made = makeHandle({ onFinished: (spec) => void specs.push(spec) });
    return { ...made, specs };
  }

  it('fires with the spec when the worker finishes normally', async () => {
    const { handle, backend, specs } = finishing();
    handle.start();
    const seg = await backend.onNextSegment();
    await seg.emit(response('report'));
    seg.complete();
    await handle.terminalPromise;
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({ workerId: WORKER_ID, workspace: '/tmp/ws' });
  });

  it('fires when the worker fails', async () => {
    const { handle, backend, specs } = finishing();
    handle.start();
    const seg = await backend.onNextSegment();
    await seg.emit({ type: 'error', error: new Error('boom') });
    await handle.terminalPromise;
    expect(specs).toHaveLength(1);
  });

  // Deferred, not skipped: the cancel path waits for the backend's cooperative
  // stop() before the spawner is told to clean up. See the dedicated describe
  // below for the wait and its bound.
  it('fires when the worker is cancelled, once stop() has settled', async () => {
    const { handle, backend, specs } = finishing();
    handle.start();
    await backend.onNextSegment();
    handle.cancel('user cancelled');
    backend.stopGate.resolve();
    await vi.waitFor(() => expect(specs).toHaveLength(1));
    expect(specs[0]).toMatchObject({ workerId: WORKER_ID });
  });

  it('fires when the backend never constructs', async () => {
    const specs: Array<Omit<WorkerSpec, 'extraTools'>> = [];
    const { handle } = makeHandle({
      backendPromise: Promise.reject(new Error('no backend')),
      onFinished: (spec) => void specs.push(spec),
    });
    handle.start();
    await handle.terminalPromise;
    expect(specs).toHaveLength(1);
  });

  it('fires exactly once even when cancel lands after a normal finish', async () => {
    const { handle, backend, specs } = finishing();
    handle.start();
    const seg = await backend.onNextSegment();
    seg.complete();
    await handle.terminalPromise;
    handle.cancel('too late');
    expect(specs).toHaveLength(1);
  });

  it('a throwing hook never breaks the terminal transition', async () => {
    const { handle, backend } = makeHandle({
      onFinished: () => {
        throw new Error('hook exploded');
      },
    });
    handle.start();
    const seg = await backend.onNextSegment();
    seg.complete();
    await handle.terminalPromise;
    expect(handle.status).toBe('done');
  });
});

describe('WorkerHandle snapshot workspace', () => {
  it('reports the spec workspace when the backend claims none', async () => {
    const { handle, backend } = makeHandle();
    handle.start();
    const seg = await backend.onNextSegment();
    seg.complete();
    await handle.terminalPromise;
    expect(handle.snapshot().workspace).toBe('/tmp/ws');
  });

  /**
   * An isolated child runs in its own worktree, not the parent's workspace. The
   * backend is the only thing that knows the resolved path, so the handle takes
   * it from there and surfaces it in the snapshot the `agent` tool reports on.
   */
  it('reports the backend workspace when the child was isolated', async () => {
    const backend = new FakeBackend();
    backend.workspace = '/data/worktrees/researcher/w-1';
    const { handle } = makeHandle({ backendPromise: Promise.resolve(backend) });
    handle.start();
    const seg = await backend.onNextSegment();
    seg.complete();
    await handle.terminalPromise;
    expect(handle.snapshot().workspace).toBe('/data/worktrees/researcher/w-1');
  });
});

/** The spec of a child that asked for its own worktree. */
function isolatedSpec(over: Partial<Omit<WorkerSpec, 'extraTools'>> = {}) {
  return {
    agentId: 'agent-1',
    agentName: 'Agent One',
    runId: RUN_ID,
    workerId: WORKER_ID,
    role: ROLE,
    brief: 'do the thing',
    model: 'test-model',
    workspace: '/tmp/ws',
    tools: [],
    isolation: 'worktree' as const,
    ...over,
  };
}

/**
 * The cancel path is the one that can destroy work: the spawner's cleanup runs
 * `git status` on the child's worktree, and pi's abort is COOPERATIVE, so a
 * cleanup that samples the tree before the child has flushed reads clean and
 * removes the directory out from under a still-running process. The hook is
 * therefore chained off `stop()` — bounded, because a `stop()` that never
 * settles must not leak the worktree instead.
 */
describe('WorkerHandle cancel settles the backend before the finished hook', () => {
  it('holds the finished hook until stop() settles', async () => {
    const specs: Array<Omit<WorkerSpec, 'extraTools'>> = [];
    const { handle, backend, terminals } = makeHandle({
      onFinished: (spec) => void specs.push(spec),
    });
    handle.start();
    await backend.onNextSegment();

    handle.cancel('user cancelled');

    // The terminal transition itself is already complete and synchronous.
    expect(handle.status).toBe('cancelled');
    expect(terminals).toHaveLength(1);
    expect(backend.stopCalls).toBe(1);
    // ...but the spawner's cleanup has NOT run: stop() is still in flight.
    await Promise.resolve();
    await Promise.resolve();
    expect(specs).toHaveLength(0);

    backend.stopGate.resolve();
    await vi.waitFor(() => expect(specs).toHaveLength(1));
  });

  it('fires the finished hook anyway when stop() never settles', async () => {
    const specs: Array<Omit<WorkerSpec, 'extraTools'>> = [];
    const { handle, backend } = makeHandle({
      onFinished: (spec) => void specs.push(spec),
      cancelStopGraceMs: 20,
    });
    backend.hangStop = true;
    handle.start();
    await backend.onNextSegment();

    handle.cancel('user cancelled');
    expect(specs).toHaveLength(0);

    // Bounded: a hung stop() delays the cleanup, it does not cancel it.
    await vi.waitFor(() => expect(specs).toHaveLength(1), { timeout: 2_000 });
  });

  it('fires the finished hook at once when the backend was never constructed', async () => {
    const specs: Array<Omit<WorkerSpec, 'extraTools'>> = [];
    const { handle } = makeHandle({
      backendPromise: new Promise<WorkerBackend>(() => {}),
      onFinished: (spec) => void specs.push(spec),
    });
    handle.start();

    handle.cancel('user cancelled');

    // Nothing was ever started, so nothing can still be writing.
    expect(specs).toHaveLength(1);
  });
});

/**
 * `snapshot().workspace` is what the `agent` tool reports to the user. For a
 * child that asked for isolation it must never name the PARENT workspace: that
 * is the exact claim isolation exists to deny, and a failed isolation would
 * otherwise report it forever.
 */
describe('WorkerHandle snapshot workspace for an isolated child', () => {
  it('reports no workspace until the worktree is known', async () => {
    const backend = new FakeBackend();
    backend.workspace = '/data/worktrees/researcher/w-1';
    const pending = deferred<WorkerBackend>();
    const { handle } = makeHandle({ spec: isolatedSpec(), backendPromise: pending.promise });

    expect(handle.snapshot().workspace).toBeUndefined();

    pending.resolve(backend);
    // Resolved off the backend promise itself: no start() needed.
    await vi.waitFor(() =>
      expect(handle.snapshot().workspace).toBe('/data/worktrees/researcher/w-1'),
    );
  });

  it('never reports the parent workspace when isolation failed', async () => {
    const { handle } = makeHandle({
      spec: isolatedSpec(),
      backendPromise: Promise.reject(new Error('isolation: worktree requires a git workspace')),
    });
    handle.start();
    await handle.terminalPromise;

    expect(handle.status).toBe('failed');
    expect(handle.snapshot().workspace).toBeUndefined();
  });

  it('still reports the shared workspace for a child that asked for no isolation', async () => {
    const { handle } = makeHandle();
    expect(handle.snapshot().workspace).toBe('/tmp/ws');
  });
});

/**
 * All three finalizers delegate to ONE terminal-transition helper, so a future
 * terminal status cannot pick up five of the six steps and silently skip the
 * spawner notification that takes the worktree down.
 */
describe('WorkerHandle terminal transition parity', () => {
  /** The observable steps of a terminal transition, in the order they happened. */
  function recorder() {
    const order: string[] = [];
    const made = makeHandle({
      emit: (event) => {
        if (event.type === 'worker_done' || event.type === 'subagent_finished') {
          order.push(event.type);
        }
      },
      hooks: { subagentStop: (w) => order.push(`subagentStop:${w.status}`) },
      onTerminal: () => order.push('onTerminal'),
      onFinished: () => void order.push('onFinished'),
    });
    return { ...made, order };
  }

  const SEQUENCE = ['worker_done', 'subagent_finished', 'subagentStop', 'onTerminal'];

  it('done, failed and cancelled all run the same terminal sequence', async () => {
    const done = recorder();
    done.handle.start();
    const seg = await done.backend.onNextSegment();
    await seg.emit(response('report'));
    seg.complete();
    await done.handle.terminalPromise;

    const failed = recorder();
    failed.handle.start();
    const failSeg = await failed.backend.onNextSegment();
    await failSeg.emit({ type: 'error', error: new Error('boom') });
    await failed.handle.terminalPromise;

    const cancelled = recorder();
    cancelled.handle.start();
    await cancelled.backend.onNextSegment();
    cancelled.handle.cancel('user cancelled');
    cancelled.backend.stopGate.resolve();
    await vi.waitFor(() => expect(cancelled.order).toContain('onFinished'));

    // Same steps, same order, differing only in the status the hook carries and
    // in WHEN the spawner notification lands (cancel waits for stop()).
    expect(done.order.filter((s) => s !== 'onFinished')).toEqual([
      ...SEQUENCE.slice(0, 2),
      'subagentStop:done',
      'onTerminal',
    ]);
    expect(failed.order.filter((s) => s !== 'onFinished')).toEqual([
      ...SEQUENCE.slice(0, 2),
      'subagentStop:failed',
      'onTerminal',
    ]);
    expect(cancelled.order.filter((s) => s !== 'onFinished')).toEqual([
      ...SEQUENCE.slice(0, 2),
      'subagentStop:cancelled',
      'onTerminal',
    ]);
    for (const r of [done, failed, cancelled]) {
      expect(r.order.filter((s) => s === 'onFinished')).toHaveLength(1);
    }
  });
});

/**
 * `maxTurns` has no backend counterpart: pi exposes no step/turn cap at all, so
 * the handle enforces it itself by counting the child's OWN `tool_use_start`
 * events, aborting the backend and finalizing with a PARTIAL report the user can
 * resume with `send_message`.
 */
describe('WorkerHandle maxTurns enforcement', () => {
  /** The exact marker a maxTurns report must lead with. */
  const PARTIAL = '[partial: maxTurns reached; resumable with send_message]';

  function makeCapped(maxTurns: number, overrides: Partial<WorkerHandleOptions> = {}) {
    return makeHandle({
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
        maxTurns,
      },
      ...overrides,
    });
  }

  it('finalizes max_turns with a partial resumable report and one backend abort', async () => {
    const { handle, backend, events } = makeCapped(2);
    handle.start();
    const seg = await backend.onNextSegment();
    await seg.emit(response('progress so far', 1, 2));
    await seg.emit({ type: 'tool_use_start', id: 't1', name: 'read' });
    await seg.emit({ type: 'tool_use_start', id: 't2', name: 'grep' });
    await seg.emit({ type: 'tool_use_start', id: 't3', name: 'read' });
    await handle.terminalPromise;

    expect(handle.status).toBe('max_turns');
    expect(handle.report).toBe(`${PARTIAL}\n\nprogress so far`);
    expect(handle.snapshot()).toMatchObject({
      status: 'max_turns',
      report: `${PARTIAL}\n\nprogress so far`,
      toolCallCount: 3,
    });
    expect(backend.abortCalls).toBe(1);
    expect(events.find((e) => e.type === 'subagent_finished')).toMatchObject({
      status: 'max_turns',
      report: `${PARTIAL}\n\nprogress so far`,
      toolCallCount: 3,
      usage: { inputTokens: 1, outputTokens: 2 },
    });
  });

  it('allows exactly maxTurns tool calls and trips on the one after', async () => {
    const { handle, backend } = makeCapped(2);
    handle.start();
    const seg = await backend.onNextSegment();
    await seg.emit({ type: 'tool_use_start', id: 't1', name: 'read' });
    await seg.emit({ type: 'tool_use_start', id: 't2', name: 'grep' });
    // Two calls is the cap, not past it: still running, backend untouched.
    await vi.waitFor(() => expect(handle.toolCallCount).toBe(2));
    expect(handle.status).toBe('running');
    expect(backend.abortCalls).toBe(0);

    await seg.emit({ type: 'tool_use_start', id: 't3', name: 'grep' });
    await handle.terminalPromise;
    expect(handle.toolCallCount).toBe(3);
    expect(handle.status).toBe('max_turns');
  });

  it('leaves an uncapped worker alone however many tool calls it makes', async () => {
    const { handle, backend } = makeHandle();
    handle.start();
    const seg = await backend.onNextSegment();
    for (const id of ['t1', 't2', 't3', 't4']) {
      await seg.emit({ type: 'tool_use_start', id, name: 'read' });
    }
    await seg.emit(response('done here'));
    seg.complete();
    await handle.terminalPromise;
    expect(handle.status).toBe('done');
    expect(handle.toolCallCount).toBe(4);
    expect(backend.abortCalls).toBe(0);
  });

  /**
   * The parked A4 item: `legacyWorkerDoneStatus` had only a unit test because
   * nothing produced `max_turns` yet. This is the end-to-end proof that the two
   * terminal events disagree on purpose — the legacy mirror flattens to `failed`
   * for the iOS / Mission Control decoders, `subagent_finished` tells the truth.
   */
  it('mirrors max_turns as failed on worker_done while subagent_finished tells the truth', async () => {
    const { handle, backend, events } = makeCapped(1);
    handle.start();
    const seg = await backend.onNextSegment();
    await seg.emit(response('partial work'));
    await seg.emit({ type: 'tool_use_start', id: 't1', name: 'read' });
    await seg.emit({ type: 'tool_use_start', id: 't2', name: 'grep' });
    await handle.terminalPromise;

    expect(events.find((e) => e.type === 'worker_done')).toMatchObject({
      workerId: WORKER_ID,
      runId: RUN_ID,
      status: 'failed',
      report: `${PARTIAL}\n\npartial work`,
    });
    expect(events.find((e) => e.type === 'subagent_finished')).toMatchObject({
      subagentId: WORKER_ID,
      status: 'max_turns',
    });
    const types = events.map((e) => e.type);
    expect(types.indexOf('worker_done')).toBeLessThan(types.indexOf('subagent_finished'));
  });

  it('does not also finalize as done when the aborted segment completes', async () => {
    let finished = 0;
    const { handle, backend, events, terminals, stops } = makeCapped(1, {
      onFinished: () => {
        finished++;
      },
    });
    handle.start();
    const seg = await backend.onNextSegment();
    await seg.emit(response('half a report'));
    await seg.emit({ type: 'tool_use_start', id: 't1', name: 'read' });
    await seg.emit({ type: 'tool_use_start', id: 't2', name: 'grep' });
    await handle.terminalPromise;

    // The abort is cooperative, so the in-flight segment still finishes. None of
    // its tail may land: no second terminal, and no overwriting of the partial.
    await seg.emit(response('a full report'));
    seg.complete();

    // For max_turns, onFinished is deferred until backend.stop() settles. The
    // fake backend holds stop() pending until stopGate is resolved.
    backend.stopGate.resolve();
    await vi.waitFor(() => expect(finished).toBe(1));

    expect(handle.status).toBe('max_turns');
    expect(handle.snapshot().report).toBe(`${PARTIAL}\n\nhalf a report`);
    expect(events.filter((e) => e.type === 'worker_done')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'subagent_finished')).toHaveLength(1);
    expect(terminals).toHaveLength(1);
    expect(stops).toEqual([{ workerId: WORKER_ID, role: ROLE, status: 'max_turns' }]);
    expect(finished).toBe(1);
  });

  /**
   * A child can trip its cap while an ask_orchestrator question is outstanding
   * (pi issues parallel tool calls). Every other terminal path SETTLES that
   * waiter; leaving it pending would strand the asking tool on a promise that
   * can never resolve, since the worker it was waiting on is gone.
   */
  it('rejects a pending ask_orchestrator question rather than stranding it', async () => {
    const { handle, backend } = makeCapped(1);
    handle.start();
    const seg = await backend.onNextSegment();
    const asked = handle.waitForQuestion('which file?', undefined, 60_000);
    expect(handle.status).toBe('waiting_input');

    await seg.emit({ type: 'tool_use_start', id: 't1', name: 'read' });
    await seg.emit({ type: 'tool_use_start', id: 't2', name: 'grep' });
    await handle.terminalPromise;

    await expect(asked).rejects.toThrow(/maxTurns/);
    expect(handle.status).toBe('max_turns');
    expect(handle.pendingQuestion).toBeUndefined();
  });

  it('runs the same terminal sequence as every other terminal status', async () => {
    const order: string[] = [];
    const { handle, backend } = makeCapped(1, {
      emit: (event) => {
        if (event.type === 'worker_done' || event.type === 'subagent_finished') {
          order.push(event.type);
        }
      },
      hooks: { subagentStop: (w) => order.push(`subagentStop:${w.status}`) },
      onTerminal: () => order.push('onTerminal'),
      onFinished: () => void order.push('onFinished'),
    });
    handle.start();
    const seg = await backend.onNextSegment();
    await seg.emit({ type: 'tool_use_start', id: 't1', name: 'read' });
    await seg.emit({ type: 'tool_use_start', id: 't2', name: 'grep' });
    await handle.terminalPromise;

    // For max_turns, onFinished is deferred until backend.stop() settles. The
    // fake backend holds stop() pending until stopGate is resolved.
    backend.stopGate.resolve();
    await vi.waitFor(() => expect(order).toContain('onFinished'));

    expect(order).toEqual([
      'worker_done',
      'subagent_finished',
      'subagentStop:max_turns',
      'onTerminal',
      'onFinished',
    ]);
  });
});
