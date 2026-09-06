import {
  type AgentBackend,
  type AgentEvent,
  type AgentState,
  DashAgent,
  type DashAgentConfig,
  type RunOptions,
} from '@dash/agent';
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

  it('waits for explicit backend readiness before sealing across config resolution', async () => {
    const configEntered = deferred<void>();
    const allowConfig = deferred<void>();
    const allowSealedUnwind = deferred<void>();
    let runCalls = 0;
    let providerCalls = 0;
    let backendPhase: 'idle' | 'active' | 'ended-unsealed' | 'sealed' = 'idle';
    const sealSteering = vi.fn(async () => {
      if (backendPhase === 'idle') return [];
      backendPhase = 'sealed';
      return ['input-ready'];
    });
    const backend: AgentBackend = {
      name: 'config-gap-backend',
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      abort: vi.fn(),
      sealSteering,
      async *run(_state: AgentState, runOptions: RunOptions): AsyncGenerator<AgentEvent> {
        runCalls++;
        backendPhase = 'active';
        let readiness: 'continue' | 'sealed' = 'continue';
        if (
          'onRunReadyForSteering' in runOptions &&
          typeof runOptions.onRunReadyForSteering === 'function'
        ) {
          readiness = await runOptions.onRunReadyForSteering();
        }
        if (readiness === 'sealed' || backendPhase !== 'active') {
          await allowSealedUnwind.promise;
          return;
        }
        providerCalls++;
        try {
          yield { type: 'text_delta', text: 'started' };
        } finally {
          if (backendPhase !== 'sealed') backendPhase = 'ended-unsealed';
        }
      },
    };
    const registry = new AgentRegistry();
    const { id } = registry.register({
      name: 'config-gap',
      model: 'anthropic/claude-sonnet-4-20250514',
      systemPrompt: 'test',
    });
    const originalChat = DashAgent.prototype.chat;
    const chatSpy = vi.spyOn(DashAgent.prototype, 'chat').mockImplementation(function (
      this: DashAgent,
      ...args: Parameters<typeof originalChat>
    ) {
      const internals = this as unknown as {
        configResolver: () => Promise<DashAgentConfig>;
      };
      const originalResolver = internals.configResolver;
      internals.configResolver = async () => {
        configEntered.resolve(undefined);
        await allowConfig.promise;
        return originalResolver();
      };
      const gen = originalChat.apply(this, args);
      return (async function* () {
        try {
          yield* gen;
        } finally {
          internals.configResolver = originalResolver;
        }
      })();
    });
    const agents = createAgentChatCoordinator({
      registry,
      poolMaxSize: 1,
      createBackend: async () => backend,
    });
    const stream = agents.chat({
      agentId: id,
      conversationId: 'shared',
      runId: 'run-ready',
      text: 'start',
      onSteerConsumed: async () => {},
    });
    const firstPull = stream.next();
    await configEntered.promise;

    let sealSettled = false;
    const sealPromise = agents.sealSteering(id, 'shared', 'run-ready').then((result) => {
      sealSettled = true;
      return result;
    });
    await Promise.resolve();
    await Promise.resolve();
    const beforeReady = {
      sealSettled,
      sealCalls: sealSteering.mock.calls.length,
      pinned: agents.stats().pinned,
    };

    allowConfig.resolve(undefined);
    const winner = await Promise.race([
      sealPromise.then((sealed) => ({ source: 'seal' as const, sealed })),
      firstPull.then((first) => ({ source: 'first' as const, first })),
    ]);
    let sealed: string[];
    let first: IteratorResult<AgentEvent>;
    let pinnedAfterSeal: number;
    let providerCallsAfterSeal: number;
    if (winner.source === 'seal') {
      sealed = winner.sealed;
      pinnedAfterSeal = agents.stats().pinned;
      providerCallsAfterSeal = providerCalls;
      allowSealedUnwind.resolve(undefined);
      first = await firstPull;
      if (!first.done) await stream.return(undefined as never);
    } else {
      first = winner.first;
      if (!first.done) await stream.return(undefined as never);
      sealed = await sealPromise;
      pinnedAfterSeal = agents.stats().pinned;
      providerCallsAfterSeal = providerCalls;
      allowSealedUnwind.resolve(undefined);
    }
    const finalPinned = agents.stats().pinned;
    await agents.stop();
    chatSpy.mockRestore();

    expect(beforeReady).toEqual({ sealSettled: false, sealCalls: 0, pinned: 1 });
    expect(winner.source).toBe('seal');
    expect(first.done).toBe(true);
    expect(sealed).toEqual(['input-ready']);
    expect(runCalls).toBe(1);
    expect(providerCallsAfterSeal).toBe(0);
    expect(backendPhase).toBe('sealed');
    expect(pinnedAfterSeal).toBe(1);
    expect(finalPinned).toBe(0);
  });
});
