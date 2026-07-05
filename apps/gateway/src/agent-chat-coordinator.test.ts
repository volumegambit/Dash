import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentBackend, AgentEvent, AgentState, RunOptions } from '@dash/agent';
import {
  SwarmCoordinator,
  type SwarmEventLogSink,
  type WorkerBackend,
  type WorkerFactory,
} from '@dash/swarm';
import { describe, expect, it, vi } from 'vitest';
import {
  type AgentChatCoordinatorSwarm,
  createAgentChatCoordinator,
} from './agent-chat-coordinator.js';
import { AgentRegistry } from './agent-registry.js';

function makeMockBackend(events: AgentEvent[]): AgentBackend {
  return {
    name: 'mock-backend',
    start: async () => {},
    stop: async () => {},
    abort: () => {},
    async *run(_state: AgentState, _options: RunOptions): AsyncGenerator<AgentEvent> {
      for (const event of events) {
        yield event;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Swarm merge-wrapper test harness
// ---------------------------------------------------------------------------

/** A deferred promise resolved/rejected externally. */
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
 * A backend whose `run()` is a hand-driven generator. The test emits
 * orchestrator events and ends the turn through the returned controller,
 * giving byte-precise control over how the orchestrator stream interleaves
 * with the swarm channel. `abort()` is recorded and also ends the turn so a
 * consumer-gone / signal abort actually settles the retained `gen.next()`.
 */
interface OrchestratorController {
  emit(event: AgentEvent): Promise<void>;
  end(): void;
  abortCalls(): number;
}

function makeScriptedBackend(): { backend: AgentBackend; controller: OrchestratorController } {
  const queue: AgentEvent[] = [];
  const takers: Array<(r: IteratorResult<AgentEvent>) => void> = [];
  let done = false;
  let aborts = 0;

  const push = (event: AgentEvent) => {
    const taker = takers.shift();
    if (taker) taker({ done: false, value: event });
    else queue.push(event);
  };
  const finish = () => {
    done = true;
    for (const t of takers.splice(0)) t({ done: true, value: undefined as never });
  };

  const backend: AgentBackend = {
    name: 'scripted-backend',
    start: async () => {},
    stop: async () => {},
    abort: () => {
      aborts++;
      // A real backend aborts its in-flight run(); model that by ending the
      // generator so the merge wrapper's retained gen.next() settles `done`.
      finish();
    },
    async *run(_state: AgentState, _options: RunOptions): AsyncGenerator<AgentEvent> {
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
    },
  };

  return {
    backend,
    controller: {
      emit: (event) => {
        push(event);
        // Give the consumer a microtask turn to observe the event before the
        // next scripted step, keeping interleaving deterministic.
        return Promise.resolve();
      },
      end: finish,
      abortCalls: () => aborts,
    },
  };
}

/** A fake worker backend: emits a scripted `response` then completes (→ done). */
function makeWorkerFactory(): {
  factory: WorkerFactory;
  release(index: number): void;
} {
  const gates: Array<ReturnType<typeof deferred<void>>> = [];
  const factory: WorkerFactory = async (spec) => {
    const gate = deferred<void>();
    gates.push(gate);
    const backend: WorkerBackend = {
      async *chat(_message: string): AsyncGenerator<AgentEvent> {
        // Block until the test releases this worker, then report and finish.
        await gate.promise;
        yield {
          type: 'response',
          content: `report from ${spec.role}`,
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
      abort: () => {},
      stop: async () => {},
    };
    return backend;
  };
  return {
    factory,
    release: (index) => gates[index]?.resolve(),
  };
}

/** A fake event-log sink recording every append. */
function makeEventLogSink() {
  const appends: Array<{
    agentId: string;
    conversationId: string;
    messageId: string;
    payload: { type: 'event'; event: AgentEvent };
  }> = [];
  const sink: SwarmEventLogSink = {
    append(agentId, conversationId, messageId, payload) {
      appends.push({
        agentId,
        conversationId,
        messageId,
        payload: payload as { type: 'event'; event: AgentEvent },
      });
      return Promise.resolve();
    },
  };
  return { sink, appends };
}

describe('AgentChatCoordinator', () => {
  it('routes a message to the correct agent and streams events', async () => {
    const registry = new AgentRegistry();
    const { id } = registry.register({
      name: 'test-agent',
      model: 'anthropic/claude-sonnet-4-20250514',
      systemPrompt: 'You are helpful.',
    });

    const expectedEvents: AgentEvent[] = [
      { type: 'text_delta', text: 'Hello' },
      {
        type: 'response',
        content: 'Hello',
        usage: { inputTokens: 10, outputTokens: 5 },
      },
    ];

    const agents = createAgentChatCoordinator({
      registry,
      poolMaxSize: 10,
      createBackend: async () => makeMockBackend(expectedEvents),
    });

    const collected: AgentEvent[] = [];
    for await (const event of agents.chat({
      agentId: id,
      conversationId: 'conv-1',
      text: 'Hi there',
    })) {
      collected.push(event);
    }

    expect(collected).toEqual(expectedEvents);
    await agents.stop();
  });

  it('accepts signal + messageId on the request and streams unchanged', async () => {
    const registry = new AgentRegistry();
    const { id } = registry.register({
      name: 'test-agent',
      model: 'anthropic/claude-sonnet-4-20250514',
      systemPrompt: 'You are helpful.',
    });

    const expectedEvents: AgentEvent[] = [
      { type: 'text_delta', text: 'Hello' },
      {
        type: 'response',
        content: 'Hello',
        usage: { inputTokens: 10, outputTokens: 5 },
      },
    ];

    const agents = createAgentChatCoordinator({
      registry,
      poolMaxSize: 10,
      createBackend: async () => makeMockBackend(expectedEvents),
    });

    const controller = new AbortController();
    const collected: AgentEvent[] = [];
    // signal + messageId are accepted on the request (Task 8 consumes them);
    // for now chat() must stream identically to a request without them.
    for await (const event of agents.chat({
      agentId: id,
      conversationId: 'conv-signal-1',
      text: 'Hi there',
      signal: controller.signal,
      messageId: 'ws-msg-1',
    })) {
      collected.push(event);
    }

    expect(collected).toEqual(expectedEvents);
    await agents.stop();
  });

  it('rejects messages to unknown agents (yields error event)', async () => {
    const registry = new AgentRegistry();
    const agents = createAgentChatCoordinator({
      registry,
      poolMaxSize: 10,
      createBackend: async () => makeMockBackend([]),
    });

    const collected: AgentEvent[] = [];
    for await (const event of agents.chat({
      agentId: 'nonexistent-id',
      conversationId: 'conv-1',
      text: 'Hello',
    })) {
      collected.push(event);
    }

    expect(collected).toHaveLength(1);
    expect(collected[0].type).toBe('error');
    const errorEvent = collected[0] as { type: 'error'; error: Error };
    expect(errorEvent.error.message).toMatch(/not found/);
    await agents.stop();
  });

  it('rejects messages to disabled agents (yields error event)', async () => {
    const registry = new AgentRegistry();
    const { id } = registry.register({
      name: 'disabled-agent',
      model: 'anthropic/claude-sonnet-4-20250514',
      systemPrompt: 'test',
    });
    registry.disable(id);

    const agents = createAgentChatCoordinator({
      registry,
      poolMaxSize: 10,
      createBackend: async () => makeMockBackend([]),
    });

    const collected: AgentEvent[] = [];
    for await (const event of agents.chat({
      agentId: id,
      conversationId: 'conv-1',
      text: 'Hello',
    })) {
      collected.push(event);
    }

    expect(collected).toHaveLength(1);
    expect(collected[0].type).toBe('error');
    const errorEvent = collected[0] as { type: 'error'; error: Error };
    expect(errorEvent.error.message).toMatch(/disabled/);
    await agents.stop();
  });
});

describe('AgentChatCoordinator.listSkills', () => {
  it('returns an agent managed skill alongside a plugin skill dir', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dash-coord-skills-'));
    try {
      const managed = join(root, 'managed');
      const skillDir = join(managed, 'my-skill');
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        join(skillDir, 'SKILL.md'),
        '---\nname: my-skill\ndescription: d\n---\n\nbody\n',
      );

      // A built-in-plugin-style skill dir (skills/<skill>/SKILL.md), the tier
      // that replaced the removed bundled library. Threaded via the same
      // getPluginSkillDirs getter the gateway uses at boot.
      const pluginSkillsDir = join(root, 'plugin-skills');
      const bundledDir = join(pluginSkillsDir, 'from-plugin');
      await mkdir(bundledDir, { recursive: true });
      await writeFile(
        join(bundledDir, 'SKILL.md'),
        '---\nname: from-plugin\ndescription: d\n---\n\nbody\n',
      );

      const registry = new AgentRegistry();
      const { id } = registry.register({
        name: 'skill-agent',
        model: 'anthropic/claude-sonnet-4-20250514',
        systemPrompt: 'x',
      });

      const agents = createAgentChatCoordinator({
        registry,
        poolMaxSize: 10,
        createBackend: async () => makeMockBackend([]),
        managedSkillsDir: (config) => (config.name === 'skill-agent' ? managed : undefined),
        getPluginSkillDirs: () => [pluginSkillsDir],
      });

      const skills = await agents.listSkills(id);
      const byName = new Map(skills.map((s) => [s.name, s]));

      // The agent's own managed skill is present and editable.
      expect(byName.has('my-skill')).toBe(true);
      expect(byName.get('my-skill')?.source).toBe('managed');

      // The plugin-dir skill is present, badged as a plugin and read-only —
      // the equivalent of the old bundled tier under the plugin pipeline.
      expect(byName.get('from-plugin')?.source).toBe('plugin');
      expect(byName.get('from-plugin')?.editable).toBe(false);
      await agents.stop();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns [] for an unknown agent', async () => {
    const registry = new AgentRegistry();
    const agents = createAgentChatCoordinator({
      registry,
      poolMaxSize: 10,
      createBackend: async () => makeMockBackend([]),
    });
    expect(await agents.listSkills('nope')).toEqual([]);
    await agents.stop();
  });
});

describe('AgentChatCoordinator.listSkills with plugin contributions', () => {
  it('surfaces plugin skill dirs and namespaced command/agent files, badged as plugin', async () => {
    // The HTTP skills route must match what chat can actually load: plugin
    // skill dirs (skills/) and plugin command/agent files (commands/, agents/,
    // namespaced `<plugin>:<name>`). Mirrors PiAgentBackend.listSkills.
    const root = await mkdtemp(join(tmpdir(), 'dash-coord-plugins-'));
    try {
      const pluginSkillsDir = join(root, 'plugin-skills');
      const greetDir = join(pluginSkillsDir, 'greet');
      await mkdir(greetDir, { recursive: true });
      await writeFile(
        join(greetDir, 'SKILL.md'),
        '---\nname: greet\ndescription: say hi\n---\n\nbody\n',
      );

      const cmdFile = join(root, 'deploy.md');
      await writeFile(cmdFile, '---\ndescription: deploy it\n---\n\nrun the deploy\n');
      const agentFile = join(root, 'reviewer.md');
      await writeFile(agentFile, '---\ndescription: reviews code\n---\n\nreview\n');

      const registry = new AgentRegistry();
      const { id } = registry.register({
        name: 'plugin-agent',
        model: 'anthropic/claude-sonnet-4-20250514',
        systemPrompt: 'x',
      });

      const agents = createAgentChatCoordinator({
        registry,
        poolMaxSize: 10,
        createBackend: async () => makeMockBackend([]),
        getPluginSkillDirs: () => [pluginSkillsDir],
        getPluginCommandFiles: () => [
          { file: cmdFile, namespace: 'acme' },
          { file: agentFile, namespace: 'acme' },
        ],
      });

      const skills = await agents.listSkills(id);
      const byName = new Map(skills.map((s) => [s.name, s]));

      // Plugin skill dir, <plugin>:<command>, and <plugin>:<agent> all present.
      expect(byName.has('greet')).toBe(true);
      expect(byName.has('acme:deploy')).toBe(true);
      expect(byName.has('acme:reviewer')).toBe(true);

      // All badged 'plugin' and non-editable (read-only in MC — a user can't
      // edit/remove a plugin-contributed skill via the managed dir).
      for (const name of ['greet', 'acme:deploy', 'acme:reviewer']) {
        expect(byName.get(name)?.source).toBe('plugin');
        expect(byName.get(name)?.editable).toBe(false);
      }

      await agents.stop();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('AgentChatCoordinator skill mutations', () => {
  function makeCoordinator(managed: string) {
    const registry = new AgentRegistry();
    const { id } = registry.register({
      name: 'skill-agent',
      model: 'anthropic/claude-sonnet-4-20250514',
      systemPrompt: 'x',
    });
    const agents = createAgentChatCoordinator({
      registry,
      poolMaxSize: 10,
      createBackend: async () => makeMockBackend([]),
      managedSkillsDir: (config) => (config.name === 'skill-agent' ? managed : undefined),
    });
    return { agents, id };
  }

  it('creates then gets a skill', async () => {
    const managed = await mkdtemp(join(tmpdir(), 'dash-coord-skills-'));
    try {
      const { agents, id } = makeCoordinator(managed);
      await agents.createSkill(id, { name: 'made', description: 'd', content: 'body' });
      expect((await agents.getSkill(id, 'made'))?.name).toBe('made');
      await agents.stop();
    } finally {
      await rm(managed, { recursive: true, force: true });
    }
  });

  it('installs from a local source and removes it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dash-coord-skills-'));
    try {
      const managed = join(root, 'managed');
      await mkdir(managed, { recursive: true });
      const src = join(root, 'fix', 'arxiv');
      await mkdir(src, { recursive: true });
      await writeFile(join(src, 'SKILL.md'), '---\nname: arxiv\ndescription: d\n---\n\nbody\n');

      const { agents, id } = makeCoordinator(managed);
      await agents.installSkill(id, src);
      expect((await agents.listSkills(id)).map((s) => s.name)).toContain('arxiv');
      await agents.removeSkill(id, 'arxiv');
      expect((await agents.listSkills(id)).map((s) => s.name)).not.toContain('arxiv');
      await agents.stop();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses to remove a read-only plugin skill (not in the managed dir)', async () => {
    // The old bundled tier is gone; the read-only tier a user must not be able
    // to delete is now plugin-contributed skills (source: 'plugin'). They live
    // under the plugin skill dir, never the agent's managed dir, so a remove
    // request cannot delete them — it rejects with 'plugin'.
    const root = await mkdtemp(join(tmpdir(), 'dash-coord-skills-'));
    try {
      const managed = join(root, 'managed');
      await mkdir(managed, { recursive: true });

      const pluginSkillsDir = join(root, 'plugin-skills');
      const skillDir = join(pluginSkillsDir, 'ranger');
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        join(skillDir, 'SKILL.md'),
        '---\nname: ranger\ndescription: d\n---\n\nbody\n',
      );

      const registry = new AgentRegistry();
      const { id } = registry.register({
        name: 'skill-agent',
        model: 'anthropic/claude-sonnet-4-20250514',
        systemPrompt: 'x',
      });
      const agents = createAgentChatCoordinator({
        registry,
        poolMaxSize: 10,
        createBackend: async () => makeMockBackend([]),
        managedSkillsDir: (config) => (config.name === 'skill-agent' ? managed : undefined),
        getPluginSkillDirs: () => [pluginSkillsDir],
      });

      const plugin = (await agents.listSkills(id)).find((s) => s.source === 'plugin');
      if (!plugin) throw new Error('expected a plugin skill');
      expect(plugin.editable).toBe(false);
      await expect(agents.removeSkill(id, plugin.name)).rejects.toMatchObject({
        code: 'plugin',
      });
      await agents.stop();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('AgentChatCoordinator swarm merge wrapper', () => {
  const MODEL = 'anthropic/claude-sonnet-4-20250514';

  function setup(opts: { swarmEnabled: boolean; eventLog?: SwarmEventLogSink }) {
    const registry = new AgentRegistry();
    const { id } = registry.register({
      name: 'orch-agent',
      model: MODEL,
      systemPrompt: 'x',
      swarm: { enabled: opts.swarmEnabled },
    });
    const { factory, release } = makeWorkerFactory();
    const coordinator = new SwarmCoordinator({ workerFactory: factory, eventLog: opts.eventLog });
    const { backend, controller } = makeScriptedBackend();
    const swarm: AgentChatCoordinatorSwarm = {
      coordinator,
      isEnabled: (agentId) => registry.get(agentId)?.config.swarm?.enabled === true,
    };
    const agents = createAgentChatCoordinator({
      registry,
      poolMaxSize: 10,
      createBackend: async () => backend,
      swarm,
    });
    return { registry, id, coordinator, controller, agents, swarm, release };
  }

  // (a) Fast path: swarm disabled → byte-identical to the plain path.
  it('(a) takes the byte-identical fast path when swarm is disabled', async () => {
    const events: AgentEvent[] = [
      { type: 'text_delta', text: 'Hello' },
      { type: 'response', content: 'Hello', usage: { inputTokens: 10, outputTokens: 5 } },
    ];
    const registry = new AgentRegistry();
    const { id } = registry.register({
      name: 'orch-agent',
      model: MODEL,
      systemPrompt: 'x',
      swarm: { enabled: false },
    });
    const { factory } = makeWorkerFactory();
    const coordinator = new SwarmCoordinator({ workerFactory: factory });
    const attachSpy = vi.spyOn(coordinator, 'attach');
    const agents = createAgentChatCoordinator({
      registry,
      poolMaxSize: 10,
      createBackend: async () => makeMockBackend(events),
      swarm: {
        coordinator,
        isEnabled: (agentId) => registry.get(agentId)?.config.swarm?.enabled === true,
      },
    });

    const collected: AgentEvent[] = [];
    for await (const e of agents.chat({ agentId: id, conversationId: 'c1', text: 'hi' })) {
      collected.push(e);
    }
    expect(collected).toEqual(events);
    // The fast path must never attach a swarm turn.
    expect(attachSpy).not.toHaveBeenCalled();
    await agents.stop();
  });

  // (b) Adversarial interleaving: every orchestrator AND worker event appears
  // exactly once; each source's relative order is preserved.
  it('(b) interleaves orchestrator and worker events with no loss, per-source order preserved', async () => {
    const { id, coordinator, controller, agents, release } = setup({ swarmEnabled: true });

    const collected: AgentEvent[] = [];
    const gen = agents.chat({ agentId: id, conversationId: 'c1', text: 'hi' });

    // Step the merge loop by pulling one event at a time from the generator and
    // scripting orchestrator emits / worker spawns between pulls. Each spawn
    // pushes worker_spawned + agent_spawned synchronously into the channel;
    // releasing a worker makes it report and finalize (worker_done{done}).
    const pull = async () => {
      const r = await gen.next();
      if (!r.done) collected.push(r.value);
      return r;
    };

    // Orchestrator emits O1; then spawns worker A (channel: spawned+agent_spawned).
    await controller.emit({ type: 'text_delta', text: 'O1' });
    await pull(); // O1
    coordinator.spawnWorker(id, 'c1', { role: 'A', brief: 'bA' });
    await pull(); // worker_spawned A (or agent_spawned — both in channel)
    await pull(); // the other of the pair
    // Orchestrator emits O2 while worker A is still running.
    await controller.emit({ type: 'text_delta', text: 'O2' });
    await pull(); // O2
    // Release worker A → response → done → worker_done{done} into channel.
    release(0);
    await pull(); // worker_done A (done)
    // Orchestrator emits O3, then ends its turn.
    await controller.emit({ type: 'text_delta', text: 'O3' });
    await pull(); // O3
    controller.end();
    // Drain the rest.
    while (!(await pull()).done) {
      /* keep pulling until the merged stream ends */
    }

    // Orchestrator events, in order.
    const orch = collected.filter((e) => e.type === 'text_delta').map((e) => e.text);
    expect(orch).toEqual(['O1', 'O2', 'O3']);
    // Worker events: exactly one worker_spawned and one worker_done{done} for A.
    const spawned = collected.filter((e) => e.type === 'worker_spawned');
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toMatchObject({ type: 'worker_spawned', role: 'A' });
    const workerDone = collected.filter((e) => e.type === 'worker_done');
    expect(workerDone).toHaveLength(1);
    expect(workerDone[0]).toMatchObject({ type: 'worker_done', status: 'done' });
    // agent_spawned appears exactly once too (no dropped loser).
    expect(collected.filter((e) => e.type === 'agent_spawned')).toHaveLength(1);

    await agents.stop();
  });

  // (c) Normal completion: a straggler worker cancelled by finalize appears as
  // worker_done{cancelled} in the yielded output (teardown-before-drain).
  it('(c) yields a straggler worker_done{cancelled} on normal completion (teardown-before-drain)', async () => {
    const { id, coordinator, controller, agents } = setup({ swarmEnabled: true });

    const collected: AgentEvent[] = [];
    const gen = agents.chat({ agentId: id, conversationId: 'c1', text: 'hi' });

    const pull = async () => {
      const r = await gen.next();
      if (!r.done) collected.push(r.value);
      return r;
    };

    await controller.emit({ type: 'text_delta', text: 'O1' });
    await pull(); // O1
    // Spawn a worker but NEVER release it — it is a straggler at turn end.
    coordinator.spawnWorker(id, 'c1', { role: 'straggler', brief: 'b' });
    await pull(); // worker_spawned
    await pull(); // agent_spawned
    // Orchestrator ends WITHOUT waiting on the worker.
    controller.end();
    while (!(await pull()).done) {
      /* drain */
    }

    const done = collected.filter((e) => e.type === 'worker_done');
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ type: 'worker_done', status: 'cancelled', role: 'straggler' });
    await agents.stop();
  });

  // (d) Consumer-gone: stream.return() mid-flight → generator finishes without
  // yielding more, workers cancelled, and the eventLog sink got the terminal
  // worker_done append (out-of-band, consumer-gone path).
  it('(d) stream.return() mid-flight cancels workers and logs the terminal worker_done', async () => {
    const { sink, appends } = makeEventLogSink();
    const { id, coordinator, controller, agents } = setup({ swarmEnabled: true, eventLog: sink });

    const collected: AgentEvent[] = [];
    const gen = agents.chat({
      agentId: id,
      conversationId: 'c1',
      text: 'hi',
      messageId: 'm-1',
    });

    await controller.emit({ type: 'text_delta', text: 'O1' });
    const first = await gen.next();
    if (!first.done) collected.push(first.value);
    coordinator.spawnWorker(id, 'c1', { role: 'w', brief: 'b' });
    // Consumer cancels mid-flight (WS close). The generator's finally runs
    // finalize({consumerAlive:false}) — no further yields.
    const ret = await gen.return(undefined as never);
    expect(ret.done).toBe(true);
    // Only the pre-cancel event was yielded; nothing after return().
    expect(collected).toEqual([{ type: 'text_delta', text: 'O1' }]);
    // Let the out-of-band fire-and-forget append settle.
    await Promise.resolve();
    await Promise.resolve();
    // The turn is finalized (no live run remains) and the worker was cancelled.
    expect(coordinator.getLiveRun(id, 'c1')).toBeUndefined();
    // The eventLog sink received the terminal worker_done for the cancelled worker.
    expect(appends.length).toBeGreaterThanOrEqual(1);
    expect(appends[0]).toMatchObject({
      agentId: id,
      conversationId: 'c1',
      messageId: 'm-1',
      payload: { type: 'event', event: { type: 'worker_done', status: 'cancelled' } },
    });
    // Prevent an unhandled-rejection from the abandoned scripted generator.
    controller.end();
    await agents.stop();
  });

  // (e) Signal abort: finalize is called promptly and orchestratorAbort fires.
  it('(e) aborting request.signal finalizes promptly and invokes orchestratorAbort', async () => {
    const { id, coordinator, controller, agents } = setup({ swarmEnabled: true });
    const controllerAbort = new AbortController();

    const collected: AgentEvent[] = [];
    const gen = agents.chat({
      agentId: id,
      conversationId: 'c1',
      text: 'hi',
      signal: controllerAbort.signal,
      messageId: 'm-1',
    });

    await controller.emit({ type: 'text_delta', text: 'O1' });
    const first = await gen.next();
    if (!first.done) collected.push(first.value);
    coordinator.spawnWorker(id, 'c1', { role: 'w', brief: 'b' });

    // Abort the request signal. The merge loop must break WITHOUT waiting for
    // the next orchestrator/worker event and run finalize in finally.
    controllerAbort.abort();
    const next = await gen.next();
    expect(next.done).toBe(true);
    expect(collected).toEqual([{ type: 'text_delta', text: 'O1' }]);

    // finalize ran: the live turn is gone, and finalize aborted the orchestrator
    // (which our scripted backend records + uses to end its run()).
    expect(coordinator.getLiveRun(id, 'c1')).toBeUndefined();
    expect(controller.abortCalls()).toBeGreaterThanOrEqual(1);
    await agents.stop();
  });

  // End-to-end: a spawn during a swarm turn works through the REAL coordinator,
  // proving the attach key (registry agentId) is consistent with the tool's
  // agentId (createSwarmTools would resolve the run by the same id).
  it('(e2e) a spawn during a turn routes through the real coordinator under the registry agentId', async () => {
    const { id, coordinator, controller, agents, release } = setup({ swarmEnabled: true });

    const collected: AgentEvent[] = [];
    const gen = agents.chat({ agentId: id, conversationId: 'c1', text: 'hi' });

    const pull = async () => {
      const r = await gen.next();
      if (!r.done) collected.push(r.value);
      return r;
    };

    await controller.emit({ type: 'text_delta', text: 'start' });
    await pull();
    // Spawn via the coordinator keyed by the REGISTRY id — the same key the
    // merge wrapper's attach() used. A live run must now exist for that key.
    const { workerId, status } = coordinator.spawnWorker(id, 'c1', { role: 'r', brief: 'b' });
    expect(status).toBe('spawning');
    expect(coordinator.getLiveRun(id, 'c1')?.runId).toBeDefined();
    await pull(); // worker_spawned
    await pull(); // agent_spawned
    release(0);
    await pull(); // worker_done{done}
    controller.end();
    while (!(await pull()).done) {
      /* drain */
    }

    const done = collected.find((e) => e.type === 'worker_done');
    expect(done).toMatchObject({ type: 'worker_done', workerId, status: 'done' });
    await agents.stop();
  });
});
