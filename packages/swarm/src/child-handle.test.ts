import type { AgentEvent } from '@dash/agent';
import { CHILD_DELETED_REASON, ChildHandle } from './child-handle.js';
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
    startTurn({ agentId, conversationId, text }) {
      if (startFailure) throw startFailure;
      const turnId = `turn-${++seq}`;
      turns.push({ turnId, text });
      ref = { agentId, conversationId, turnId };
      return { turnId };
    },
    cancelTurn(_agentId, conversationId) {
      cancels.push(conversationId);
      return Promise.resolve();
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
    setWorkspace(value: string) {
      workspace = value;
    },
    failStart(error: Error) {
      startFailure = error;
    },
    emit(event: AgentEvent) {
      if (!ref) throw new Error('no turn started');
      for (const listener of [...eventListeners]) listener(ref, event);
    },
    finish(outcome: ChildTurnOutcome, error?: string) {
      if (!ref) throw new Error('no turn started');
      for (const listener of [...finishListeners]) listener(ref, outcome, error);
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
  opts: { heartbeatMs?: number } = {},
) {
  const events: AgentEvent[] = [];
  const terminals: string[] = [];
  const handle = new ChildHandle({
    spec: baseSpec(over),
    driver,
    emit: (event) => events.push(event),
    maxSteers: 2,
    heartbeatMs: opts.heartbeatMs ?? 10_000,
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
});
