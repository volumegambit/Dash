import {
  type AgentBackend,
  type AgentEvent,
  type AgentState,
  DashAgent,
  type DashAgentConfig,
  MemoryStore,
  type RunOptions,
} from '@dash/agent';
import { SwarmCoordinator, type WorkerFactory } from '@dash/swarm';
import { describe, expect, it, vi } from 'vitest';
import { GatewayAdmissionController } from './admission-controller.js';
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

  it('settles a pre-ready seal and owner when cancellation aborts permanently held config', async () => {
    const configEntered = deferred<void>();
    const allowConfig = deferred<void>();
    const sealSteering = vi.fn(async () => ['must-not-be-sealed']);
    const run = vi.fn(async function* (): AsyncGenerator<AgentEvent> {
      yield { type: 'text_delta', text: 'provider started' };
    });
    const backend: AgentBackend = {
      name: 'cancel-before-readiness',
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      abort: vi.fn(),
      sealSteering,
      run,
    };
    const registry = new AgentRegistry();
    const { id } = registry.register({
      name: 'cancel-before-readiness',
      model: 'anthropic/claude-sonnet-4-20250514',
      systemPrompt: 'test',
    });
    const originalChat = DashAgent.prototype.chat;
    const chatSpy = vi.spyOn(DashAgent.prototype, 'chat').mockImplementation(function (
      this: DashAgent,
      ...args: Parameters<typeof originalChat>
    ) {
      const internals = this as unknown as { configResolver: () => Promise<DashAgentConfig> };
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
    const controller = new AbortController();
    const stream = agents.chat({
      agentId: id,
      conversationId: 'held-config',
      runId: 'run-held-config',
      text: 'start',
      signal: controller.signal,
      onSteerConsumed: async () => {},
    });
    const firstPull = stream.next();
    await configEntered.promise;
    const seal = agents.sealSteering(id, 'held-config', 'run-held-config');

    controller.abort();
    expect(agents.cancel(id, 'held-config')).toBe(true);

    let sealOutcome: string[] | undefined;
    let firstOutcome: IteratorResult<AgentEvent> | undefined;
    void seal.then((value) => {
      sealOutcome = value;
    });
    void firstPull.then((value) => {
      firstOutcome = value;
    });
    try {
      await vi.waitFor(() => expect(sealOutcome).toEqual([]));
      await vi.waitFor(() => expect(firstOutcome).toMatchObject({ done: true }));
      expect(run).not.toHaveBeenCalled();
      expect(sealSteering).not.toHaveBeenCalled();
      expect(agents.stats().pinned).toBe(0);
    } finally {
      allowConfig.resolve(undefined);
      const first = await firstPull;
      if (!first.done) await stream.return(undefined as never);
      await Promise.allSettled([seal]);
      await agents.stop();
      chatSpy.mockRestore();
    }
  });

  it.each(['config', 'memory'] as const)(
    'interrupts a legacy channel run held in %s preparation without an external signal',
    async (heldPhase) => {
      const preparationEntered = deferred<void>();
      const allowPreparation = deferred<void>();
      const run = vi.fn(async function* (): AsyncGenerator<AgentEvent> {
        yield { type: 'text_delta', text: 'provider started' };
      });
      const backend: AgentBackend = {
        name: `held-channel-${heldPhase}`,
        start: vi.fn(async () => {}),
        stop: vi.fn(async () => {}),
        abort: vi.fn(),
        run,
      };
      const registry = new AgentRegistry();
      const { id } = registry.register({
        name: `held-channel-${heldPhase}`,
        model: 'anthropic/claude-sonnet-4-20250514',
        systemPrompt: 'test',
      });
      let chatSpy: ReturnType<typeof vi.spyOn> | undefined;
      let memorySpy: ReturnType<typeof vi.spyOn> | undefined;
      if (heldPhase === 'config') {
        const originalChat = DashAgent.prototype.chat;
        chatSpy = vi.spyOn(DashAgent.prototype, 'chat').mockImplementation(function (
          this: DashAgent,
          ...args: Parameters<typeof originalChat>
        ) {
          const internals = this as unknown as { configResolver: () => Promise<DashAgentConfig> };
          const originalResolver = internals.configResolver;
          internals.configResolver = async () => {
            preparationEntered.resolve(undefined);
            await allowPreparation.promise;
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
      } else {
        memorySpy = vi.spyOn(MemoryStore.prototype, 'list').mockImplementationOnce(async () => {
          preparationEntered.resolve(undefined);
          await allowPreparation.promise;
          return [];
        });
      }
      const agents = createAgentChatCoordinator({
        registry,
        poolMaxSize: 1,
        createBackend: async () => backend,
        ...(heldPhase === 'memory' ? { memoryDir: () => '/held-channel-memory' } : {}),
      });
      const stream = agents.chat({
        agentId: id,
        conversationId: `held-channel-${heldPhase}`,
        text: 'channel message',
      });
      const firstPull = stream.next();
      await preparationEntered.promise;

      agents.interruptAll();

      let firstOutcome: IteratorResult<AgentEvent> | undefined;
      void firstPull.then((value) => {
        firstOutcome = value;
      });
      try {
        await vi.waitFor(() => expect(firstOutcome).toMatchObject({ done: true }));
        expect(run).not.toHaveBeenCalled();
        expect(backend.abort).toHaveBeenCalledOnce();
        expect(agents.stats().pinned).toBe(0);
      } finally {
        allowPreparation.resolve(undefined);
        const first = await firstPull;
        if (!first.done) await stream.return(undefined as never);
        await agents.stop();
        chatSpy?.mockRestore();
        memorySpy?.mockRestore();
      }
    },
  );
});

describe('AgentChatCoordinator shared admission', () => {
  function registerAgent(registry: AgentRegistry, name: string) {
    return registry.register({
      name,
      model: 'anthropic/claude-sonnet-4-20250514',
      systemPrompt: 'test',
    });
  }

  function idleBackend(name: string): AgentBackend {
    return {
      name,
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      abort: vi.fn(),
      run: vi.fn(async function* (): AsyncGenerator<AgentEvent> {
        yield { type: 'response', content: 'ok', usage: { inputTokens: 1, outputTokens: 1 } };
      }),
    };
  }

  it.each([
    { label: 'legacy direct run behind an agent fence', fence: 'agent', swarm: false },
    { label: 'legacy direct run behind a process fence', fence: 'process', swarm: false },
    { label: 'typed swarm orchestrator behind an agent fence', fence: 'agent', swarm: true },
    { label: 'typed swarm orchestrator behind a process fence', fence: 'process', swarm: true },
  ] as const)(
    'does not start a $label when admission retires during Steer reconciliation',
    async ({ fence, swarm }) => {
      const reconcileEntered = deferred<void>();
      const allowReconcile = deferred<void>();
      const run = vi.fn(async function* (): AsyncGenerator<AgentEvent> {
        yield { type: 'text_delta', text: 'provider started' };
      });
      const backend: AgentBackend = {
        ...idleBackend('reconcile-admission'),
        reconcileSteers: vi.fn(async () => {
          reconcileEntered.resolve(undefined);
          await allowReconcile.promise;
        }),
        run,
      };
      const registry = new AgentRegistry();
      const agent = registry.register({
        name: `reconcile-${fence}-${swarm ? 'swarm' : 'direct'}`,
        model: 'anthropic/claude-sonnet-4-20250514',
        systemPrompt: 'test',
        ...(swarm ? { swarm: { enabled: true } } : {}),
      });
      const admission = new GatewayAdmissionController();
      const swarmCoordinator = new SwarmCoordinator({
        workerFactory: async () => {
          throw new Error('workers are not used by this test');
        },
      });
      const attach = vi.spyOn(swarmCoordinator, 'attach');
      const agents = createAgentChatCoordinator({
        registry,
        poolMaxSize: 1,
        createBackend: async () => backend,
        admission,
        ...(swarm ? { swarm: { coordinator: swarmCoordinator, isEnabled: () => true } } : {}),
      });
      const stream = agents.chat({
        agentId: agent.id,
        conversationId: 'shared',
        text: 'start',
        deliveredSteers: [],
        ...(swarm ? { runId: 'run-1', onSteerConsumed: async () => {} } : {}),
      });
      const firstPull = stream.next();
      await reconcileEntered.promise;

      if (fence === 'agent') admission.closeAgent(agent.id);
      else admission.closeAll();
      allowReconcile.resolve(undefined);
      const first = await firstPull;
      if (!first.done) await stream.return(undefined as never);
      await agents.stop();

      expect(first.done).toBe(true);
      expect(run).not.toHaveBeenCalled();
      expect(attach).not.toHaveBeenCalled();
    },
  );

  it.each(['agent', 'process'] as const)(
    'threads the %s admission fence through legacy config resolution',
    async (fence) => {
      const configEntered = deferred<void>();
      const allowConfig = deferred<void>();
      const run = vi.fn(async function* (): AsyncGenerator<AgentEvent> {
        yield { type: 'text_delta', text: 'provider started' };
      });
      const backend: AgentBackend = { ...idleBackend('config-admission'), run };
      const registry = new AgentRegistry();
      const agent = registerAgent(registry, `config-${fence}`);
      const admission = new GatewayAdmissionController();
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
        admission,
      });
      const stream = agents.chat({
        agentId: agent.id,
        conversationId: 'legacy',
        text: 'start',
      });
      const firstPull = stream.next();
      await configEntered.promise;

      if (fence === 'agent') admission.closeAgent(agent.id);
      else admission.closeAll();
      allowConfig.resolve(undefined);
      const first = await firstPull;
      if (!first.done) await stream.return(undefined as never);
      await agents.stop();
      chatSpy.mockRestore();

      expect(first.done).toBe(true);
      expect(run).not.toHaveBeenCalled();
    },
  );

  it.each(['agent', 'process'] as const)(
    'rechecks the %s admission fence at typed provider readiness',
    async (fence) => {
      const readinessEntered = deferred<void>();
      const allowReadiness = deferred<void>();
      let providerCalls = 0;
      const backend: AgentBackend = {
        ...idleBackend('readiness-admission'),
        sealSteering: vi.fn(async () => []),
        async *run(_state, runOptions): AsyncGenerator<AgentEvent> {
          readinessEntered.resolve(undefined);
          await allowReadiness.promise;
          if ((await runOptions.onRunReadyForSteering?.()) === 'sealed') return;
          providerCalls++;
          yield { type: 'text_delta', text: 'provider started' };
        },
      };
      const registry = new AgentRegistry();
      const agent = registerAgent(registry, `readiness-${fence}`);
      const admission = new GatewayAdmissionController();
      const agents = createAgentChatCoordinator({
        registry,
        poolMaxSize: 1,
        createBackend: async () => backend,
        admission,
      });
      const stream = agents.chat({
        agentId: agent.id,
        conversationId: 'typed',
        runId: 'run-1',
        text: 'start',
        onSteerConsumed: async () => {},
      });
      const firstPull = stream.next();
      await readinessEntered.promise;

      if (fence === 'agent') admission.closeAgent(agent.id);
      else admission.closeAll();
      allowReadiness.resolve(undefined);
      const first = await firstPull;
      if (!first.done) await stream.return(undefined as never);
      await agents.sealSteering(agent.id, 'typed', 'run-1');
      await agents.stop();

      expect(first.done).toBe(true);
      expect(providerCalls).toBe(0);
    },
  );

  it('stops a backend factory completed after an agent fence and keys the fence by stable id', async () => {
    const registry = new AgentRegistry();
    const agent = registerAgent(registry, 'mutable display name');
    const admission = new GatewayAdmissionController();
    const factory = deferred<AgentBackend>();
    const backend = idleBackend('late');
    const createBackend = vi.fn(() => factory.promise);
    const agents = createAgentChatCoordinator({
      registry,
      poolMaxSize: 2,
      createBackend,
      admission,
    });

    const stream = agents.chat({ agentId: agent.id, conversationId: 'blocked', text: 'hello' });
    const first = stream.next();
    await vi.waitFor(() => expect(createBackend).toHaveBeenCalledOnce());
    admission.closeAgent(agent.id);
    factory.resolve(backend);

    await expect(first).rejects.toThrow(/not accepting|disabled|retired/);
    expect(backend.stop).toHaveBeenCalledOnce();
    expect(backend.run).not.toHaveBeenCalled();
    await agents.stop();
  });

  it('rejects only a quarantined conversation before pool creation', async () => {
    const registry = new AgentRegistry();
    const agent = registerAgent(registry, 'quarantine');
    const admission = new GatewayAdmissionController();
    admission.markRecoveryRequired(agent.id, 'bad');
    const createBackend = vi.fn(async () => idleBackend('healthy'));
    const agents = createAgentChatCoordinator({
      registry,
      poolMaxSize: 2,
      createBackend,
      admission,
    });

    await expect(
      agents.chat({ agentId: agent.id, conversationId: 'bad', text: 'blocked' }).next(),
    ).rejects.toThrow(/recovery/);
    await drain(agents.chat({ agentId: agent.id, conversationId: 'good', text: 'allowed' }));
    expect(createBackend).toHaveBeenCalledOnce();
    await agents.stop();
  });
});
