import type { AgentEvent } from '@dash/agent';
import { CHILD_DELETED_REASON, ChildHandle, type ChildHandleOptions } from './child-handle.js';
import { childConversationId } from './child-id.js';
import type {
  ChildConversationInput,
  ChildInfo,
  ChildSnapshot,
  ChildSpec,
  ChildTurnDriver,
  ChildTurnOutcome,
  ChildTurnRef,
  WorkerStatus,
} from './types.js';

interface RecordedTurn {
  turnId: string;
  text: string;
  requestId?: string;
}

/**
 * A scripted {@link ChildTurnDriver}: records the conversation it was asked to
 * create, hands each turn back to the test, and lets the test push events and
 * finish it. Nothing here runs a backend — that is exactly the seam the child
 * lifetime now sits behind.
 */
function fakeDriver() {
  const created: ChildConversationInput[] = [];
  const prepared: ChildSpec[] = [];
  const turns: RecordedTurn[] = [];
  const patches: Array<{ id: string; status?: WorkerStatus; info?: Partial<ChildInfo> }> = [];
  const released: string[] = [];
  const cancels: string[] = [];
  let alive = true;
  let cancelGate: Promise<void> | undefined;
  let releaseCancelGate: (() => void) | undefined;
  let workspace: string | undefined;
  let startFailure: Error | undefined;
  let seq = 0;
  const eventListeners = new Set<(t: ChildTurnRef, e: AgentEvent) => void>();
  const finishListeners = new Set<(t: ChildTurnRef, o: ChildTurnOutcome, error?: string) => void>();
  let ref: ChildTurnRef | undefined;

  const driver: ChildTurnDriver = {
    prepareChild(spec) {
      prepared.push(spec);
    },
    createChild(input) {
      created.push(input);
    },
    startTurn({ agentId, conversationId, text, requestId }) {
      if (startFailure) throw startFailure;
      const turnId = `turn-${++seq}`;
      turns.push({ turnId, text, ...(requestId !== undefined ? { requestId } : {}) });
      ref = { agentId, conversationId, turnId };
      return { turnId };
    },
    cancelTurn(_agentId, conversationId) {
      cancels.push(conversationId);
      // Held open when the test wants to observe what happens BEFORE the
      // driver's abort settles — the window the cancel grace period covers.
      return cancelGate ?? Promise.resolve();
    },
    updateChild(id, patch) {
      patches.push({ id, ...patch });
    },
    listChildren(): ChildSnapshot[] {
      return [];
    },
    isChildAlive() {
      return alive;
    },
    workspaceOf() {
      return workspace;
    },
    onEvent(listener) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    onFinish(listener) {
      finishListeners.add(listener);
      return () => finishListeners.delete(listener);
    },
    releaseChild(id) {
      released.push(id);
    },
  };

  return {
    driver,
    created,
    prepared,
    turns,
    patches,
    released,
    cancels,
    setAlive(value: boolean) {
      alive = value;
    },
    /** Make `cancelTurn` hang until {@link releaseCancel} (or forever). */
    holdCancel() {
      cancelGate = new Promise<void>((resolve) => {
        releaseCancelGate = resolve;
      });
    },
    releaseCancel() {
      releaseCancelGate?.();
    },
    setWorkspace(value: string) {
      workspace = value;
    },
    failStart(error: Error) {
      startFailure = error;
    },
    emit(event: AgentEvent, turnId?: string) {
      if (!ref) throw new Error('no turn started');
      const target = turnId ? { ...ref, turnId } : ref;
      for (const listener of [...eventListeners]) listener(target, event);
    },
    finish(outcome: ChildTurnOutcome, error?: string, turnId?: string) {
      if (!ref) throw new Error('no turn started');
      const target = turnId ? { ...ref, turnId } : ref;
      for (const listener of [...finishListeners]) listener(target, outcome, error);
    },
  };
}

const CHILD_ID = childConversationId();

function baseSpec(
  over: Partial<Omit<ChildSpec, 'extraTools'>> = {},
): Omit<ChildSpec, 'extraTools'> {
  return {
    agentId: 'agent-1',
    agentName: 'Agent One',
    runId: 'turn-parent',
    workerId: CHILD_ID,
    childConversationId: CHILD_ID,
    parentConversationId: 'convo-1',
    parentTurnId: 'turn-parent',
    role: 'researcher',
    brief: 'find the thing',
    model: 'orch-model',
    workspace: '/repo',
    tools: ['read'],
    description: 'find the thing',
    subagentType: 'general-purpose',
    depth: 1,
    ...over,
  };
}

function makeHandle(
  driver: ChildTurnDriver,
  over: Partial<Omit<ChildSpec, 'extraTools'>> = {},
  opts: {
    heartbeatMs?: number;
    maxSteers?: number;
    cancelStopGraceMs?: number;
    onFinished?: ChildHandleOptions['onFinished'];
    resumeWith?: string;
    resumeRequestId?: string;
  } = {},
) {
  const events: AgentEvent[] = [];
  const terminals: string[] = [];
  const handle = new ChildHandle({
    spec: baseSpec(over),
    driver,
    emit: (event) => events.push(event),
    maxSteers: opts.maxSteers ?? 2,
    heartbeatMs: opts.heartbeatMs ?? 10_000,
    ...(opts.resumeWith !== undefined ? { resumeWith: opts.resumeWith } : {}),
    ...(opts.resumeRequestId !== undefined ? { resumeRequestId: opts.resumeRequestId } : {}),
    ...(opts.cancelStopGraceMs !== undefined ? { cancelStopGraceMs: opts.cancelStopGraceMs } : {}),
    ...(opts.onFinished ? { onFinished: opts.onFinished } : {}),
    onTerminal: (h) => terminals.push(h.status),
  });
  return { handle, events, terminals };
}

const response = (content: string): AgentEvent => ({
  type: 'response',
  content,
  usage: { inputTokens: 3, outputTokens: 4 },
});

const toolStart = (name: string): AgentEvent => ({
  type: 'tool_use_start',
  id: `t-${name}`,
  name,
  input: {},
});

describe('ChildHandle', () => {
  it('creates the child conversation and starts a turn with the brief', () => {
    const d = fakeDriver();
    const { handle, events } = makeHandle(d.driver);
    handle.start();

    expect(d.created).toHaveLength(1);
    expect(d.created[0]).toMatchObject({
      id: CHILD_ID,
      agentId: 'agent-1',
      parentConversationId: 'convo-1',
      parentTurnId: 'turn-parent',
      subagent: { type: 'general-purpose', status: 'running', depth: 1, prompt: 'find the thing' },
    });
    expect(d.turns).toEqual([{ turnId: 'turn-1', text: 'find the thing' }]);
    expect(events.find((e) => e.type === 'subagent_started')).toMatchObject({
      subagentId: CHILD_ID,
      depth: 1,
    });
    expect(handle.status).toBe('running');
  });

  it('tracks tool calls and the report, and finishes done with subagent_finished', async () => {
    const d = fakeDriver();
    const { handle, events, terminals } = makeHandle(d.driver);
    handle.start();
    d.emit(toolStart('read'));
    d.emit(response('the report'));
    d.finish('completed');
    await handle.terminalPromise;

    expect(handle.status).toBe('done');
    expect(handle.toolCallCount).toBe(1);
    expect(handle.report).toBe('the report');
    expect(terminals).toEqual(['done']);
    expect(events.find((e) => e.type === 'subagent_finished')).toMatchObject({
      status: 'done',
      report: 'the report',
      toolCallCount: 1,
      usage: { inputTokens: 3, outputTokens: 4 },
    });
    // The legacy mirror still leads, so a worker_done-only decoder keeps working.
    const order = events.map((e) => e.type);
    expect(order.indexOf('worker_done')).toBeLessThan(order.indexOf('subagent_finished'));
    expect(d.patches.at(-1)).toMatchObject({
      id: CHILD_ID,
      status: 'done',
      info: { report: 'the report', toolCallCount: 1 },
    });
    expect(d.released).toEqual([]);
  });

  it('runs a queued steer as a second turn on the same conversation', async () => {
    const d = fakeDriver();
    const { handle } = makeHandle(d.driver);
    handle.start();
    expect(handle.send('also check the tests')).toEqual({ ok: true });
    d.finish('completed');

    expect(d.turns).toEqual([
      { turnId: 'turn-1', text: 'find the thing' },
      { turnId: 'turn-2', text: 'also check the tests' },
    ]);
    expect(handle.status).toBe('running');

    d.emit(response('done both'));
    d.finish('completed');
    await handle.terminalPromise;
    expect(handle.status).toBe('done');
  });

  it("carries a steer's requestId to the turn that steer becomes", async () => {
    const d = fakeDriver();
    const { handle } = makeHandle(d.driver);
    handle.start();
    expect(handle.send('also check the tests', 'req-a')).toEqual({ ok: true });
    d.finish('completed');

    // The FIRST turn is the brief, which no client asked for and so carries
    // no correlation id; the second is the steer's.
    expect(d.turns).toEqual([
      { turnId: 'turn-1', text: 'find the thing' },
      { turnId: 'turn-2', text: 'also check the tests', requestId: 'req-a' },
    ]);
    expect(d.turns[0].requestId).toBeUndefined();
  });

  it('keeps each queued steer with its own requestId, in order', () => {
    const d = fakeDriver();
    const { handle } = makeHandle(d.driver, {}, { maxSteers: 4 });
    handle.start();
    handle.send('first', 'req-1');
    handle.send('second', 'req-2');
    d.finish('completed');
    expect(d.turns[1]).toEqual({ turnId: 'turn-2', text: 'first', requestId: 'req-1' });
    d.finish('completed');
    expect(d.turns[2]).toEqual({ turnId: 'turn-3', text: 'second', requestId: 'req-2' });
  });

  it('starts a resume turn with the resume requestId', () => {
    const d = fakeDriver();
    const { handle } = makeHandle(
      d.driver,
      {},
      { resumeWith: 'pick this back up', resumeRequestId: 'req-resume' },
    );
    handle.start();
    expect(d.turns).toEqual([
      { turnId: 'turn-1', text: 'pick this back up', requestId: 'req-resume' },
    ]);
  });

  it('spends no requestId on an ANSWER: no turn starts, so nothing echoes it', async () => {
    const d = fakeDriver();
    const { handle } = makeHandle(d.driver);
    handle.start();
    const answered = handle.waitForQuestion('which file?', undefined, 60_000);
    expect(handle.send('the second one', 'req-answer')).toEqual({ ok: true });
    await expect(answered).resolves.toBe('the second one');
    // Still one turn: the answer resolved inside it.
    expect(d.turns).toEqual([{ turnId: 'turn-1', text: 'find the thing' }]);
  });

  it('reports the failure text of a failed turn', async () => {
    const d = fakeDriver();
    const { handle } = makeHandle(d.driver);
    handle.start();
    d.finish('failed', 'provider refused the request');
    await handle.terminalPromise;

    expect(handle.status).toBe('failed');
    expect(handle.report).toBe('provider refused the request');
  });

  it('fails the child when the driver refuses to start its turn', async () => {
    const d = fakeDriver();
    d.failStart(new Error('Resumable chat hub is stopped'));
    const { handle, events } = makeHandle(d.driver);
    handle.start();
    await handle.terminalPromise;

    expect(handle.status).toBe('failed');
    expect(handle.report).toBe('Resumable chat hub is stopped');
    // The card still terminalizes: a spawn that never ran must not leave a
    // subagent_started with no matching subagent_finished.
    expect(events.find((e) => e.type === 'subagent_started')).toBeDefined();
    expect(events.find((e) => e.type === 'subagent_finished')).toMatchObject({ status: 'failed' });
  });

  it('cancel is synchronous, aborts the child turn and never resurrects', async () => {
    const d = fakeDriver();
    const { handle } = makeHandle(d.driver);
    handle.start();
    handle.cancel('user cancelled');

    expect(handle.status).toBe('cancelled');
    expect(d.cancels).toEqual([CHILD_ID]);
    await handle.terminalPromise;
    d.finish('completed');
    expect(handle.status).toBe('cancelled');
  });

  it('trips maxTurns after the capped tool call and keeps the partial report', async () => {
    const d = fakeDriver();
    const { handle } = makeHandle(d.driver, { maxTurns: 1 });
    handle.start();
    d.emit(response('partial findings'));
    d.emit(toolStart('read'));
    d.emit(toolStart('grep'));
    await handle.terminalPromise;

    expect(handle.status).toBe('max_turns');
    expect(handle.report).toContain('[partial: maxTurns reached');
    expect(handle.report).toContain('partial findings');
  });

  it('cancels itself when its conversation is deleted out from under it', async () => {
    const d = fakeDriver();
    const { handle } = makeHandle(d.driver, {}, { heartbeatMs: 1 });
    handle.start();
    d.setAlive(false);
    await handle.terminalPromise;

    expect(handle.status).toBe('cancelled');
    expect(handle.report).toBe(CHILD_DELETED_REASON);
  });

  it('reports the workspace the runtime says the child ran in', () => {
    const d = fakeDriver();
    const { handle } = makeHandle(d.driver, { isolation: 'worktree' });
    handle.start();
    // Before the runtime mints the checkout there is no honest answer.
    expect(handle.snapshot().workspace).toBeUndefined();
    d.setWorkspace('/data/worktrees/Agent One/child');
    expect(handle.snapshot().workspace).toBe('/data/worktrees/Agent One/child');
  });

  it('ignores a turn on its conversation that it did not start', async () => {
    const d = fakeDriver();
    const { handle } = makeHandle(d.driver);
    handle.start();
    // A client typed into the child's own conversation: its transcript is
    // addressable, so this is a real turn — but it is not the child's task, and
    // neither its events nor its completion may touch the child's report.
    d.emit(response('someone else said this'), 'foreign-turn');
    d.finish('completed', undefined, 'foreign-turn');

    expect(handle.status).toBe('running');
    expect(handle.report).toBeUndefined();

    d.emit(response('the real report'));
    d.finish('completed');
    await handle.terminalPromise;
    expect(handle.report).toBe('the real report');
  });

  it('a persist failure never breaks the terminal transition', async () => {
    const d = fakeDriver();
    const throwing: ChildTurnDriver = {
      ...d.driver,
      updateChild() {
        throw new Error('conversation is gone');
      },
    };
    const { handle } = makeHandle(throwing);
    handle.start();
    d.finish('completed');
    await handle.terminalPromise;
    expect(handle.status).toBe('done');
  });

  // ---------------------------------------------------------------------
  // The invariants `WorkerHandle` used to carry, ported onto the one child
  // lifetime that implements them now (C4 review item 6). Each of these was
  // the ONLY assertion of its behaviour anywhere in the repo.
  // ---------------------------------------------------------------------

  /** Invariant 1 (child-handle.ts): enqueue and completion cannot interleave. */
  it('never silently drops a steer in the enqueue-vs-completion race', async () => {
    const d = fakeDriver();
    const { handle } = makeHandle(d.driver);
    handle.start();
    d.emit(response('turn one'));
    d.finish('completed');
    // Steer in the very next synchronous turn, before awaiting anything.
    const res = handle.send('race steer');

    if (res.ok) {
      // Accepted: a second turn MUST run with this message.
      expect(d.turns.map((t) => t.text)).toEqual(['find the thing', 'race steer']);
    } else {
      // Refused as terminal: the child must actually be terminal, and no turn
      // may have been started for the steer.
      expect(res.reason).toBe('worker terminal');
      await handle.terminalPromise;
      expect(['done', 'failed', 'cancelled']).toContain(handle.status);
      expect(d.turns).toHaveLength(1);
    }
  });

  it('rejects send() on a terminal child', async () => {
    const d = fakeDriver();
    const { handle } = makeHandle(d.driver);
    handle.start();
    d.emit(response('done'));
    d.finish('completed');
    await handle.terminalPromise;

    expect(handle.send('too late')).toEqual({ ok: false, reason: 'worker terminal' });
  });

  it('rejects steers past maxSteers with steer cap reached', () => {
    const d = fakeDriver();
    const { handle } = makeHandle(d.driver, {}, { maxSteers: 2 });
    handle.start();

    expect(handle.send('steer 1')).toEqual({ ok: true });
    expect(handle.send('steer 2')).toEqual({ ok: true });
    expect(handle.send('steer 3')).toEqual({ ok: false, reason: 'steer cap reached' });
    expect(handle.steersUsed).toBe(2);
  });

  it('cancel() is idempotent', () => {
    const d = fakeDriver();
    const { handle, events, terminals } = makeHandle(d.driver);
    handle.start();
    handle.cancel('once');
    handle.cancel('twice');

    expect(terminals).toEqual(['cancelled']);
    expect(d.cancels).toEqual([CHILD_ID]);
    expect(events.filter((e) => e.type === 'worker_done')).toHaveLength(1);
    expect(handle.report).toBe('once');
  });

  it('answerQuestion returns false when nothing is waiting', () => {
    const d = fakeDriver();
    const { handle } = makeHandle(d.driver);
    handle.start();
    expect(handle.answerQuestion('nobody asked')).toBe(false);
  });

  /**
   * The cancel grace race: the spawner's cleanup (the gateway removes an
   * isolated child's worktree) must not sample a directory the child is still
   * writing to, so it waits for the driver's abort — but only up to the grace
   * period, or a hung abort would leak the directory forever.
   */
  it('holds the finished hook until the driver abort settles', async () => {
    const d = fakeDriver();
    const finished: string[] = [];
    d.holdCancel();
    const { handle, terminals } = makeHandle(
      d.driver,
      {},
      { onFinished: (spec) => void finished.push(spec.workerStatus) },
    );
    handle.start();

    handle.cancel('user cancelled');

    // The terminal transition itself is synchronous and already complete.
    expect(handle.status).toBe('cancelled');
    expect(terminals).toEqual(['cancelled']);
    await Promise.resolve();
    await Promise.resolve();
    // ...but the spawner's cleanup has not run: the abort is still in flight.
    expect(finished).toEqual([]);

    d.releaseCancel();
    await vi.waitFor(() => expect(finished).toEqual(['cancelled']));
  });

  it('fires the finished hook anyway when the driver abort never settles', async () => {
    const d = fakeDriver();
    const finished: string[] = [];
    d.holdCancel(); // never released
    const { handle } = makeHandle(
      d.driver,
      {},
      { cancelStopGraceMs: 20, onFinished: (spec) => void finished.push(spec.workerStatus) },
    );
    handle.start();

    handle.cancel('user cancelled');
    expect(finished).toEqual([]);

    // Bounded: a hung abort delays the cleanup, it does not cancel it.
    await vi.waitFor(() => expect(finished).toEqual(['cancelled']), { timeout: 2_000 });
  });
});
