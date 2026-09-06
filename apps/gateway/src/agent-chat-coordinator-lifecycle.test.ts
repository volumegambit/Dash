import type { AgentBackend, AgentEvent, AgentState, RunOptions } from '@dash/agent';
import { SwarmCoordinator, type WorkerFactory } from '@dash/swarm';
import { describe, expect, it, vi } from 'vitest';
import { createAgentChatCoordinator } from './agent-chat-coordinator.js';
import { AgentRegistry } from './agent-registry.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function drain(gen: AsyncGenerator<AgentEvent>): Promise<void> {
  for await (const _event of gen) {
    // consume
  }
}

type PullOutcome =
  | { status: 'fulfilled'; result: IteratorResult<AgentEvent> }
  | { status: 'rejected'; error: unknown };

async function exerciseMixedRunConflict(options: {
  firstRunId?: string;
  secondRunId?: string;
  swarm: boolean;
}): Promise<{ outcome: PullOutcome; attachCalls: number; runCalls: number }> {
  const finishFirst = deferred<void>();
  let runCalls = 0;
  const backend: AgentBackend = {
    name: 'permissive-lifecycle-backend',
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    abort: vi.fn(),
    sealSteering: vi.fn(async () => []),
    async *run(_state: AgentState, _runOptions: RunOptions): AsyncGenerator<AgentEvent> {
      const index = runCalls++;
      yield { type: 'text_delta', text: `run-${index + 1}` };
      if (index === 0) await finishFirst.promise;
    },
  };
  const registry = new AgentRegistry();
  const { id } = registry.register({
    name: `lifecycle-${options.firstRunId ?? 'legacy'}-${options.secondRunId ?? 'legacy'}`,
    model: 'anthropic/claude-sonnet-4-20250514',
    systemPrompt: 'test',
    ...(options.swarm ? { swarm: { enabled: true } } : {}),
  });
  const workerFactory: WorkerFactory = async () => {
    throw new Error('workers are not used by this lifecycle test');
  };
  const swarmCoordinator = new SwarmCoordinator({ workerFactory });
  const attach = vi.spyOn(swarmCoordinator, 'attach');
  const agents = createAgentChatCoordinator({
    registry,
    poolMaxSize: 2,
    createBackend: async () => backend,
    ...(options.swarm ? { swarm: { coordinator: swarmCoordinator, isEnabled: () => true } } : {}),
  });

  const first = agents.chat({
    agentId: id,
    conversationId: 'shared',
    text: 'first',
    ...(options.firstRunId ? { runId: options.firstRunId, onSteerConsumed: async () => {} } : {}),
  });
  expect(await first.next()).toMatchObject({ done: false });

  const second = agents.chat({
    agentId: id,
    conversationId: 'shared',
    text: 'second',
    ...(options.secondRunId ? { runId: options.secondRunId, onSteerConsumed: async () => {} } : {}),
  });
  const outcome: PullOutcome = await second.next().then(
    (result) => ({ status: 'fulfilled', result }),
    (error: unknown) => ({ status: 'rejected', error }),
  );
  if (outcome.status === 'fulfilled') await second.return(undefined as never);

  finishFirst.resolve(undefined);
  await drain(first);
  if (options.firstRunId) {
    await agents.sealSteering(id, 'shared', options.firstRunId);
  }
  if (options.secondRunId && outcome.status === 'fulfilled') {
    await agents.sealSteering(id, 'shared', options.secondRunId);
  }
  const observations = { outcome, attachCalls: attach.mock.calls.length, runCalls };
  await agents.stop();
  return observations;
}

describe('AgentChatCoordinator run ownership lifecycle', () => {
  it('lets a typed run exclude a concurrent legacy run on the same conversation', async () => {
    const result = await exerciseMixedRunConflict({
      firstRunId: 'typed-first',
      swarm: false,
    });

    expect(result.outcome).toMatchObject({
      status: 'rejected',
      error: { message: expect.stringMatching(/already owns/) },
    });
    expect(result.runCalls).toBe(1);
  });

  it('lets a legacy run exclude a concurrent typed run on the same conversation', async () => {
    const result = await exerciseMixedRunConflict({
      secondRunId: 'typed-second',
      swarm: false,
    });

    expect(result.outcome).toMatchObject({
      status: 'rejected',
      error: { message: expect.stringMatching(/already owns/) },
    });
    expect(result.runCalls).toBe(1);
  });

  it.each([
    { firstRunId: 'typed-first', secondRunId: undefined },
    { firstRunId: undefined, secondRunId: 'typed-second' },
  ])('rejects mixed $firstRunId/$secondRunId swarm ownership before attach', async (runIds) => {
    const result = await exerciseMixedRunConflict({ ...runIds, swarm: true });

    expect(result.outcome).toMatchObject({
      status: 'rejected',
      error: { message: expect.stringMatching(/already owns/) },
    });
    expect(result.attachCalls).toBe(1);
    expect(result.runCalls).toBe(1);
  });

  it('prevents a typed run from starting when seal arrives during blocked reconciliation', async () => {
    const reconcileEntered = deferred<void>();
    const allowReconcile = deferred<void>();
    let runCalls = 0;
    let backendPhase: 'idle' | 'active' | 'ended-unsealed' | 'sealed' = 'idle';
    const sealSteering = vi.fn(async () => {
      if (backendPhase === 'idle') return [];
      backendPhase = 'sealed';
      return ['input-1'];
    });
    const backend: AgentBackend = {
      name: 'blocked-reconciliation-backend',
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      abort: vi.fn(),
      reconcileSteers: vi.fn(async () => {
        reconcileEntered.resolve(undefined);
        await allowReconcile.promise;
      }),
      sealSteering,
      async *run(_state: AgentState, _runOptions: RunOptions): AsyncGenerator<AgentEvent> {
        runCalls++;
        backendPhase = 'active';
        try {
          yield { type: 'text_delta', text: 'unexpected' };
        } finally {
          if (backendPhase !== 'sealed') backendPhase = 'ended-unsealed';
        }
      },
    };
    const registry = new AgentRegistry();
    const { id } = registry.register({
      name: 'blocked-reconciliation',
      model: 'anthropic/claude-sonnet-4-20250514',
      systemPrompt: 'test',
    });
    const agents = createAgentChatCoordinator({
      registry,
      poolMaxSize: 1,
      createBackend: async () => backend,
    });
    const stream = agents.chat({
      agentId: id,
      conversationId: 'shared',
      runId: 'run-1',
      text: 'start',
      onSteerConsumed: async () => {},
      deliveredSteers: [],
    });
    const firstPull = stream.next();
    await reconcileEntered.promise;

    const sealed = await agents.sealSteering(id, 'shared', 'run-1');
    allowReconcile.resolve(undefined);
    const first = await firstPull;
    if (!first.done) await stream.return(undefined as never);
    const observations = {
      sealed,
      first,
      runCalls,
      backendPhase,
      sealCalls: sealSteering.mock.calls.length,
      pinned: agents.stats().pinned,
    };
    await agents.stop();

    expect(observations.sealed).toEqual([]);
    expect(observations.first.done).toBe(true);
    expect(observations.runCalls).toBe(0);
    expect(observations.backendPhase).toBe('idle');
    expect(observations.sealCalls).toBe(0);
    expect(observations.pinned).toBe(0);
  });
});
