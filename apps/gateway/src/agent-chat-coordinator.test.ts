import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentBackend, AgentEvent, AgentState, RunOptions } from '@dash/agent';
import { SwarmCoordinator, type SwarmEventLogSink } from '@dash/swarm';
import { describe, expect, it, vi } from 'vitest';
import {
  type AgentChatCoordinatorSwarm,
  createAgentChatCoordinator,
} from './agent-chat-coordinator.js';
import { AgentRegistry } from './agent-registry.js';
import {
  type WorkerBackend,
  type WorkerFactory,
  createFakeChildDriver,
} from './fake-child-driver.js';
import { isSubagentsEnabled } from './subagent-config.js';

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

/**
 * Mock backend that records the `AgentState` it receives on each run(). Used to
 * prove that per-message config (model, allowedProviders, ...) is re-resolved
 * live from the registry on every chat() — not frozen at backend construction.
 */
function makeStateCapturingBackend(): { backend: AgentBackend; states: AgentState[] } {
  const states: AgentState[] = [];
  const backend: AgentBackend = {
    name: 'state-capture-backend',
    start: async () => {},
    stop: async () => {},
    abort: () => {},
    async *run(state: AgentState, _options: RunOptions): AsyncGenerator<AgentEvent> {
      states.push(state);
      yield { type: 'response', content: 'ok', usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  return { backend, states };
}

async function drain(gen: AsyncGenerator<AgentEvent>): Promise<void> {
  for await (const _ of gen) {
    // consume
  }
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
  specs: Array<{ role: string; workspace: string }>;
} {
  const gates: Array<ReturnType<typeof deferred<void>>> = [];
  const specs: Array<{ role: string; workspace: string }> = [];
  const factory: WorkerFactory = async (spec) => {
    specs.push({ role: spec.role, workspace: spec.workspace });
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
    specs,
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

describe('AgentChatCoordinator.refreshCustomTools', () => {
  /**
   * The sub-agent roster is rendered lazily into the `agent` tool's schema, so
   * a definition write has to reach the WARM backends of that agent — an
   * `evict` would take the conversation down with it. This is the seam the
   * definition registry's `onChange` drives; without it a roster change is
   * invisible until the gateway restarts.
   */
  function makeRefreshableBackend() {
    const refreshCustomTools = vi.fn();
    const backend: AgentBackend = {
      name: 'refreshable-backend',
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn(),
      refreshCustomTools,
      async *run(): AsyncGenerator<AgentEvent> {
        yield { type: 'text_delta', text: 'warm' };
      },
    };
    return { backend, refreshCustomTools };
  }

  it('pokes every warm backend of the agent and leaves the conversation warm', async () => {
    const registry = new AgentRegistry();
    const { id } = registry.register({
      name: 'roster-agent',
      model: 'anthropic/claude-sonnet-4-20250514',
      systemPrompt: 'You are helpful.',
    });
    const first = makeRefreshableBackend();
    const second = makeRefreshableBackend();
    const backends = [first.backend, second.backend];
    const agents = createAgentChatCoordinator({
      registry,
      poolMaxSize: 10,
      createBackend: async () => backends.shift() ?? first.backend,
    });
    await drain(agents.chat({ agentId: id, conversationId: 'conv-a', text: 'warm' }));
    await drain(agents.chat({ agentId: id, conversationId: 'conv-b', text: 'warm' }));

    await agents.refreshCustomTools(id);

    expect(first.refreshCustomTools).toHaveBeenCalledTimes(1);
    expect(second.refreshCustomTools).toHaveBeenCalledTimes(1);
    // NOT an eviction: the warm entries survive, so the next turn continues the
    // same pi session with the new roster rather than starting a fresh one.
    expect(first.backend.stop).not.toHaveBeenCalled();
    expect(agents.stats().size).toBe(2);

    await agents.stop();
  });

  it('leaves another agent alone and tolerates a backend without the hook', async () => {
    const registry = new AgentRegistry();
    const mine = registry.register({
      name: 'mine',
      model: 'anthropic/claude-sonnet-4-20250514',
      systemPrompt: 'p',
    });
    const other = registry.register({
      name: 'other',
      model: 'anthropic/claude-sonnet-4-20250514',
      systemPrompt: 'p',
    });
    const refreshable = makeRefreshableBackend();
    // No `refreshCustomTools`: the hook is optional on AgentBackend and a
    // backend that freezes its tools must not make the refresh throw.
    const plain = makeMockBackend([{ type: 'text_delta', text: 'warm' }]);
    const agents = createAgentChatCoordinator({
      registry,
      poolMaxSize: 10,
      createBackend: async (_config, _conversationId, agentId) =>
        agentId === mine.id ? refreshable.backend : plain,
    });
    await drain(agents.chat({ agentId: mine.id, conversationId: 'c1', text: 'warm' }));
    await drain(agents.chat({ agentId: other.id, conversationId: 'c2', text: 'warm' }));

    await expect(agents.refreshCustomTools(other.id)).resolves.toBeUndefined();
    expect(refreshable.refreshCustomTools).not.toHaveBeenCalled();

    await agents.refreshCustomTools(mine.id);
    expect(refreshable.refreshCustomTools).toHaveBeenCalledTimes(1);

    await agents.stop();
  });
});

describe('AgentChatCoordinator', () => {
  it('answers questions and hard-cancels through an existing warm conversation', async () => {
    const registry = new AgentRegistry();
    const { id } = registry.register({
      name: 'control-agent',
      model: 'anthropic/claude-sonnet-4-20250514',
      systemPrompt: 'You are helpful.',
    });
    const answerQuestion = vi.fn().mockResolvedValue(undefined);
    const abort = vi.fn();
    const backend: AgentBackend = {
      name: 'control-backend',
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      abort,
      answerQuestion,
      async *run(): AsyncGenerator<AgentEvent> {
        yield { type: 'text_delta', text: 'warm' };
      },
    };
    const agents = createAgentChatCoordinator({
      registry,
      poolMaxSize: 10,
      createBackend: async () => backend,
    });
    await drain(
      agents.chat({ agentId: id, conversationId: 'conversation-01', text: 'Warm the pool' }),
    );

    await agents.answerQuestion(id, 'conversation-01', 'question-01', 'Blue');
    expect(answerQuestion).toHaveBeenCalledWith('question-01', [['Blue']]);
    expect(agents.cancel(id, 'conversation-01')).toBe(true);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(agents.cancel(id, 'missing-conversation')).toBe(false);
    await expect(
      agents.answerQuestion(id, 'missing-conversation', 'question-02', 'No'),
    ).rejects.toThrow('No active conversation to answer');

    await agents.stop();
  });

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

describe('AgentChatCoordinator live per-message provider allow-list', () => {
  it('a WARM backend enforces a restriction added AFTER the conversation started (no eviction)', async () => {
    const registry = new AgentRegistry();
    // Register with NO provider restriction.
    const { id } = registry.register({
      name: 'live-agent',
      model: 'anthropic/claude-sonnet-4-20250514',
      systemPrompt: 'x',
    });

    const { backend, states } = makeStateCapturingBackend();
    // createBackend is invoked once per pool entry; return the SAME instance so
    // the second chat() reuses the warm backend (the exact scenario under test).
    const agents = createAgentChatCoordinator({
      registry,
      poolMaxSize: 10,
      createBackend: async () => backend,
    });

    // First message: warms the backend while the agent is unrestricted.
    await drain(agents.chat({ agentId: id, conversationId: 'conv-1', text: 'one' }));
    expect(states[0].allowedProviders).toBeUndefined();

    // Restrict providers AFTER the conversation exists. No eviction happens.
    registry.update(id, { providers: ['anthropic'] });

    // Second message on the SAME warm backend picks up the live restriction.
    await drain(agents.chat({ agentId: id, conversationId: 'conv-1', text: 'two' }));
    expect(states[1].allowedProviders).toEqual(['anthropic']);

    await agents.stop();
  });

  it('a WARM backend created UNDER a restriction allows again once the restriction is cleared', async () => {
    const registry = new AgentRegistry();
    // Register restricted to anthropic only.
    const { id } = registry.register({
      name: 'live-agent-2',
      model: 'anthropic/claude-sonnet-4-20250514',
      systemPrompt: 'x',
      providers: ['anthropic'],
    });

    const { backend, states } = makeStateCapturingBackend();
    const agents = createAgentChatCoordinator({
      registry,
      poolMaxSize: 10,
      createBackend: async () => backend,
    });

    // First message: warms the backend while restricted.
    await drain(agents.chat({ agentId: id, conversationId: 'conv-1', text: 'one' }));
    expect(states[0].allowedProviders).toEqual(['anthropic']);

    // Clear the restriction (null = MC clear sentinel → back to all).
    registry.update(id, { providers: null });

    // Second message on the warm backend sees the cleared (undefined) list.
    await drain(agents.chat({ agentId: id, conversationId: 'conv-1', text: 'two' }));
    expect(states[1].allowedProviders).toBeUndefined();

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
  it('surfaces plugin skill dirs and namespaced command files, badged as plugin', async () => {
    // The HTTP skills route must match what chat can actually load: plugin
    // skill dirs (skills/) and plugin command files (commands/, namespaced
    // `<plugin>:<command>`). Mirrors PiAgentBackend.listSkills.
    //
    // B2: plugin `agents/*.md` are sub-agent DEFINITIONS, not loadable skills
    // (spec §6.2). The gateway keeps them out of `getPluginCommandFiles`, so
    // this fixture feeds two COMMANDS — no agent file — matching real wiring.
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
      const cmdFile2 = join(root, 'triage.md');
      await writeFile(cmdFile2, '---\ndescription: triage it\n---\n\ntriage\n');

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
          { file: cmdFile2, namespace: 'acme' },
        ],
      });

      const skills = await agents.listSkills(id);
      const byName = new Map(skills.map((s) => [s.name, s]));

      // Plugin skill dir and both <plugin>:<command> entries present.
      expect(byName.has('greet')).toBe(true);
      expect(byName.has('acme:deploy')).toBe(true);
      expect(byName.has('acme:triage')).toBe(true);

      // All badged 'plugin' and non-editable (read-only in MC — a user can't
      // edit/remove a plugin-contributed skill via the managed dir).
      for (const name of ['greet', 'acme:deploy', 'acme:triage']) {
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

  function setup(opts: {
    swarmEnabled: boolean;
    eventLog?: SwarmEventLogSink;
    workspace?: string;
  }) {
    const registry = new AgentRegistry();
    const { id } = registry.register({
      name: 'orch-agent',
      model: MODEL,
      systemPrompt: 'x',
      swarm: { enabled: opts.swarmEnabled },
      ...(opts.workspace !== undefined ? { workspace: opts.workspace } : {}),
    });
    const { factory, release, specs } = makeWorkerFactory();
    const coordinator = new SwarmCoordinator({
      childDriver: createFakeChildDriver(factory),
      eventLog: opts.eventLog,
    });
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
    return { registry, id, coordinator, controller, agents, swarm, release, specs };
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
    const coordinator = new SwarmCoordinator({ childDriver: createFakeChildDriver(factory) });
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

  // The orchestrator's MCP grant must reach attach(), or the coordinator's
  // validateMcpTools bound stays empty and refuses every MCP-carrying spawn —
  // the exact half-wired state that kept the MCP path dormant.
  it('passes the swarm gate orchestratorMcpTools straight into attach()', async () => {
    const registry = new AgentRegistry();
    const { id } = registry.register({
      name: 'orch-agent',
      model: MODEL,
      systemPrompt: 'x',
      swarm: { enabled: true },
    });
    const { factory } = makeWorkerFactory();
    const coordinator = new SwarmCoordinator({ childDriver: createFakeChildDriver(factory) });
    const attachSpy = vi.spyOn(coordinator, 'attach');
    const agents = createAgentChatCoordinator({
      registry,
      poolMaxSize: 10,
      createBackend: async () => makeMockBackend([]),
      swarm: {
        coordinator,
        isEnabled: () => true,
        orchestratorMcpTools: (agentId) => (agentId === id ? ['github__pr'] : []),
      },
    });

    for await (const _ of agents.chat({ agentId: id, conversationId: 'c1', text: 'hi' })) {
      /* drain */
    }
    expect(attachSpy.mock.calls[0]?.[0].orchestratorMcpTools).toEqual(['github__pr']);
    await agents.stop();
  });

  it('leaves attach() undeclared when the gate reports no MCP tools', async () => {
    const { id, coordinator, controller, agents } = setup({ swarmEnabled: true });
    const attachSpy = vi.spyOn(coordinator, 'attach');
    const gen = agents.chat({ agentId: id, conversationId: 'c1', text: 'hi' });
    const first = gen.next();
    controller.end();
    await first;
    while (!(await gen.next()).done) {
      /* drain */
    }
    expect(attachSpy.mock.calls[0]?.[0].orchestratorMcpTools).toBeUndefined();
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

  // (g) THE default-configuration path: an agent registered with NEITHER a
  // `swarm` nor a `subagents` block — every agent that predates sub-agents.
  // It takes the merge path and is told to delegate, so its spawns MUST be
  // allowed. Regression for `getAgentGate` reading `swarm?.enabled === true`,
  // which made every such spawn throw "swarm is disabled for this agent" — a
  // tool-presence assertion does not catch it, only a real spawn does.
  it('(g) a spawn SUCCEEDS for an agent with no swarm and no subagents block', async () => {
    const registry = new AgentRegistry();
    // NOTE: no `swarm`, no `subagents`. Do not add either to this fixture.
    const { id } = registry.register({ name: 'default-agent', model: MODEL, systemPrompt: 'x' });
    const { factory, release } = makeWorkerFactory();
    const coordinator = new SwarmCoordinator({ childDriver: createFakeChildDriver(factory) });
    const { backend, controller } = makeScriptedBackend();
    const agents = createAgentChatCoordinator({
      registry,
      poolMaxSize: 10,
      createBackend: async () => backend,
      // The REAL gateway gate (index.ts) — sub-agents on by default.
      swarm: {
        coordinator,
        isEnabled: (agentId) => {
          const e = registry.get(agentId);
          return !!e && isSubagentsEnabled(e.config);
        },
      },
    });

    const collected: AgentEvent[] = [];
    const gen = agents.chat({ agentId: id, conversationId: 'c1', text: 'hi' });
    const pull = async () => {
      const r = await gen.next();
      if (!r.done) collected.push(r.value);
      return r;
    };

    await controller.emit({ type: 'text_delta', text: 'start' });
    await pull();
    // The merge path must have attached a turn (not taken the fast path)...
    expect(coordinator.getLiveRun(id, 'c1')).toBeUndefined(); // run is lazy until first spawn
    // ...and the coordinator's live gate re-read must ALLOW this spawn.
    const { workerId, status } = coordinator.spawnWorker(id, 'c1', { role: 'r', brief: 'b' });
    expect(status).toBe('spawning');
    await pull(); // worker_spawned
    await pull(); // agent_spawned
    release(0);
    await pull(); // worker_done{done}
    controller.end();
    while (!(await pull()).done) {
      /* drain */
    }
    expect(collected.find((e) => e.type === 'worker_done')).toMatchObject({
      workerId,
      status: 'done',
    });
    await agents.stop();
  });

  // (h) The gate still bites when an operator explicitly turns sub-agents off
  // mid-turn: the coordinator re-reads it per spawn.
  it('(h) rejects a spawn once subagents.enabled is flipped off mid-turn', async () => {
    const { id, registry, coordinator, controller, agents } = setup({ swarmEnabled: true });

    const gen = agents.chat({ agentId: id, conversationId: 'c1', text: 'hi' });
    const pull = () => gen.next();
    await controller.emit({ type: 'text_delta', text: 'start' });
    await pull();

    registry.update(id, { subagents: { enabled: false } });
    expect(() => coordinator.spawnWorker(id, 'c1', { role: 'r', brief: 'b' })).toThrow(
      /disabled for this agent/,
    );

    controller.end();
    while (!(await pull()).done) {
      /* drain */
    }
    await agents.stop();
  });

  // (f) Workspace threading: an agent config with a workspace set → the merge
  // wrapper's attach() carries it, and spawned workers sandbox to THAT workspace
  // (not the gateway's process cwd).
  it('(f) threads the orchestrator workspace into the worker spec', async () => {
    const AGENT_WORKSPACE = '/tmp/agent-swarm-fixture-workspace';
    const { id, coordinator, controller, agents, release, specs } = setup({
      swarmEnabled: true,
      workspace: AGENT_WORKSPACE,
    });

    const gen = agents.chat({ agentId: id, conversationId: 'c1', text: 'hi' });
    const pull = async () => {
      const r = await gen.next();
      return r;
    };

    await controller.emit({ type: 'text_delta', text: 'start' });
    await pull();
    coordinator.spawnWorker(id, 'c1', { role: 'w', brief: 'b' });
    await pull(); // worker_spawned
    await pull(); // agent_spawned

    // The fake factory recorded the spec it was handed — the workspace must be
    // the orchestrator's, NOT process.cwd().
    expect(specs).toHaveLength(1);
    expect(specs[0].workspace).toBe(AGENT_WORKSPACE);
    expect(specs[0].workspace).not.toBe(process.cwd());

    release(0);
    await pull(); // worker_done{done}
    controller.end();
    while (!(await pull()).done) {
      /* drain */
    }
    await agents.stop();
  });
});

// The delegation section (Task A6) is appended to the resolved systemPrompt on
// every turn, so a change to the roster or the delegation mode reaches a WARM
// backend on the next message without a pool eviction.
describe('AgentChatCoordinator delegation section', () => {
  const MODEL = 'anthropic/claude-sonnet-4-20250514';

  /**
   * Minimal coordinator stub: the delegation section only needs `rosterFor`.
   * `isEnabled` is false so `chat()` stays on the plain fast path — the section
   * is gated on the agent's own `subagents`/`swarm` config, not on the merge.
   */
  function stubSwarm(roster: Array<{ id: string; name?: string; type: string; status: string }>): {
    swarm: AgentChatCoordinatorSwarm;
    calls: Array<[string, string]>;
  } {
    const calls: Array<[string, string]> = [];
    const coordinator = {
      rosterFor: (agentId: string, conversationId: string) => {
        calls.push([agentId, conversationId]);
        return roster;
      },
    } as unknown as SwarmCoordinator;
    return { swarm: { coordinator, isEnabled: () => false }, calls };
  }

  it('appends the roster-bearing delegation section to the resolved system prompt', async () => {
    const registry = new AgentRegistry();
    const { id } = registry.register({ name: 'orch', model: MODEL, systemPrompt: 'base prompt' });
    const { backend, states } = makeStateCapturingBackend();
    const { swarm, calls } = stubSwarm([
      { id: 'w1', name: 'mapper', type: 'Explore', status: 'running' },
    ]);
    const agents = createAgentChatCoordinator({
      registry,
      poolMaxSize: 10,
      createBackend: async () => backend,
      swarm,
    });

    await drain(agents.chat({ agentId: id, conversationId: 'conv-a', text: 'hi' }));

    expect(states[0].systemPrompt).toContain('base prompt');
    expect(states[0].systemPrompt).toContain('# Delegation');
    expect(states[0].systemPrompt).toContain('- mapper (Explore, running)');
    expect(states[0].systemPrompt.trimEnd().endsWith('- mapper (Explore, running)')).toBe(true);
    // The roster is scoped to THIS conversation.
    expect(calls).toEqual([[id, 'conv-a']]);
    await agents.stop();
  });

  it('uses the explicit-mode guidance for a non-frontier model and auto for tier 0', async () => {
    const registry = new AgentRegistry();
    const { id } = registry.register({ name: 'orch', model: MODEL, systemPrompt: 'p' });
    const { backend, states } = makeStateCapturingBackend();
    const { swarm } = stubSwarm([]);
    const tiers = new Map<string, number>([[MODEL, 1]]);
    const agents = createAgentChatCoordinator({
      registry,
      poolMaxSize: 10,
      createBackend: async () => backend,
      swarm,
      modelTier: (model) => tiers.get(model),
    });

    await drain(agents.chat({ agentId: id, conversationId: 'conv-b', text: 'hi' }));
    expect(states[0].systemPrompt).toContain('only when the user asks');

    // Same WARM backend, model promoted to tier 0 → the next turn flips to auto.
    tiers.set(MODEL, 0);
    await drain(agents.chat({ agentId: id, conversationId: 'conv-b', text: 'again' }));
    expect(states[1].systemPrompt).toContain('Delegate proactively');
    await agents.stop();
  });

  it('omits the section for an agent with sub-agents disabled', async () => {
    const registry = new AgentRegistry();
    const { id } = registry.register({
      name: 'orch',
      model: MODEL,
      systemPrompt: 'p',
      subagents: { enabled: false },
    });
    const { backend, states } = makeStateCapturingBackend();
    const { swarm } = stubSwarm([]);
    const agents = createAgentChatCoordinator({
      registry,
      poolMaxSize: 10,
      createBackend: async () => backend,
      swarm,
    });

    await drain(agents.chat({ agentId: id, conversationId: 'conv-c', text: 'hi' }));
    expect(states[0].systemPrompt).not.toContain('# Delegation');
    await agents.stop();
  });
});

// ---------------------------------------------------------------------------
// Child conversations on the shared pool (Task C3 review fixes).
// ---------------------------------------------------------------------------

describe('child conversations on the shared pool', () => {
  function makeChildAgents(opts: {
    childRuntime: NonNullable<Parameters<typeof createAgentChatCoordinator>[0]['childRuntime']>;
    childAttachOptions: NonNullable<
      Parameters<typeof createAgentChatCoordinator>[0]['childAttachOptions']
    >;
  }) {
    const registry = new AgentRegistry();
    const { id } = registry.register({
      name: 'parent-agent',
      model: 'anthropic/claude-sonnet-4-20250514',
      systemPrompt: 'You are helpful.',
      workspace: '/agent/repo',
      fallbackModels: ['anthropic/claude-haiku-4-20250514'],
      tools: ['read', 'bash'],
    });
    const attaches: Array<Record<string, unknown>> = [];
    const swarm: AgentChatCoordinatorSwarm = {
      coordinator: {
        attach: (o: Record<string, unknown>) => {
          attaches.push(o);
          return {
            runIdHint: 'r',
            // Drained immediately: this harness is about what `attach` was
            // GIVEN, not about interleaving worker events.
            channel: { take: () => Promise.resolve({ done: true, value: undefined }) },
            closed: new AbortController().signal,
            live: true,
            finalize: () => {},
          };
        },
        rosterFor: () => [],
      } as unknown as SwarmCoordinator,
      isEnabled: () => true,
      orchestratorMcpTools: () => ['github__pr'],
    };
    const agents = createAgentChatCoordinator({
      registry,
      poolMaxSize: 10,
      createBackend: async () => makeMockBackend([{ type: 'text_delta', text: 'parent' }]),
      swarm,
      childRuntime: opts.childRuntime,
      childAttachOptions: opts.childAttachOptions,
    });
    return { agents, agentId: id, attaches };
  }

  const childBackend = () => makeMockBackend([{ type: 'text_delta', text: 'child' }]);

  it('a nested spawn is attached with the CHILD grant, clearing the agent fallbacks', async () => {
    const { agents, agentId, attaches } = makeChildAgents({
      childRuntime: async () => ({
        backend: childBackend(),
        resolveConfig: () => ({ model: 'test/child-model', systemPrompt: 'child' }),
        workspace: '/data/worktrees/parent-agent/sub_1',
      }),
      childAttachOptions: () => ({
        orchestratorModel: 'test/child-model',
        orchestratorFallbackModels: undefined,
        orchestratorTools: ['read'],
        orchestratorMcpTools: [],
        workspace: '/data/worktrees/parent-agent/sub_1',
      }),
    });

    await drain(agents.chat({ agentId, conversationId: 'sub_child', text: 'go' }));

    expect(attaches[0]).toMatchObject({
      orchestratorModel: 'test/child-model',
      orchestratorTools: ['read'],
      orchestratorMcpTools: [],
      workspace: '/data/worktrees/parent-agent/sub_1',
    });
    // The agent's own fallback chain must NOT survive onto a child's turn: a
    // grandchild could otherwise be pinned to a model the child's definition
    // never allowed.
    expect(attaches[0].orchestratorFallbackModels).toBeUndefined();
  });

  /**
   * C4 review item 1 (Critical). `releaseChild` leaves a finished child's pool
   * entry WARM on purpose, and `childRuntime` only runs on a pool MISS — so a
   * resumed child kept running on the `PiAgentBackend` built from its ORIGINAL
   * grant. The attachment was narrowed correctly (that only bounds a
   * grandchild); the child's own tools were not. These two drive the child's
   * OWN runtime, not the attachment.
   */
  it("rebuilds a resumed child's backend when its grant has narrowed", async () => {
    // What the coordinator would rebuild + re-intersect for this child.
    let grant = { tools: ['read', 'bash'], model: 'test/child-model' };
    const builtWith: string[][] = [];
    const { agents, agentId } = makeChildAgents({
      childRuntime: async () => {
        builtWith.push([...grant.tools]);
        return {
          backend: childBackend(),
          resolveConfig: () => ({
            model: grant.model,
            systemPrompt: 'child',
            tools: [...grant.tools],
          }),
          workspace: '/data/worktrees/parent-agent/sub_1',
        };
      },
      childAttachOptions: () => ({
        orchestratorModel: grant.model,
        orchestratorFallbackModels: undefined,
        allowedModels: undefined,
        orchestratorTools: [...grant.tools],
        orchestratorMcpTools: [],
        workspace: '/data/worktrees/parent-agent/sub_1',
      }),
    });

    await drain(agents.chat({ agentId, conversationId: 'sub_child', text: 'go' }));
    expect(builtWith).toEqual([['read', 'bash']]);

    // The operator removes `bash` from the agent; the rebuild narrows the child.
    grant = { tools: ['read'], model: 'test/child-model' };
    await drain(agents.chat({ agentId, conversationId: 'sub_child', text: 'resume' }));

    // The warm entry cannot be reused: its backend still holds `bash`.
    expect(builtWith).toEqual([['read', 'bash'], ['read']]);
  });

  /**
   * Round 2, item 1. The drop is REFUSED for a pinned (mid-turn) entry, and
   * writing the new signature anyway turns a transient overlap into a
   * permanent stale backend: the wide entry is re-labelled narrow, so every
   * later turn matches and never rebuilds. A turn that cannot be given a
   * correctly-bounded backend is refused instead.
   */
  it('refuses — and does not relabel — when the stale child entry cannot be dropped', async () => {
    let grant = ['read', 'bash'];
    const builtWith: string[][] = [];
    // A child backend whose run() blocks until the test releases it, so the
    // first turn is still in flight (pinned) when the second arrives.
    let release!: () => void;
    let runs = 0;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { agents, agentId } = makeChildAgents({
      childRuntime: async () => {
        const tools = [...grant];
        builtWith.push(tools);
        return {
          backend: {
            name: 'gated-child',
            start: async () => {},
            stop: async () => {},
            abort: () => {},
            async *run(): AsyncGenerator<AgentEvent> {
              // Only the FIRST turn is held open (that is what pins the entry);
              // a second turn that wrongly reuses this backend must complete,
              // so the assertion below reads as a wrong ANSWER rather than a
              // timeout.
              const mine = ++runs;
              yield { type: 'text_delta', text: `run-${mine}` };
              if (mine === 1) await gate;
              yield {
                type: 'response',
                content: 'done',
                usage: { inputTokens: 1, outputTokens: 1 },
              };
            },
          },
          resolveConfig: () => ({ model: 'test/child-model', systemPrompt: 'child', tools }),
          workspace: '/data/worktrees/parent-agent/sub_1',
        };
      },
      childAttachOptions: () => ({
        orchestratorModel: 'test/child-model',
        orchestratorFallbackModels: undefined,
        orchestratorTools: [...grant],
        orchestratorMcpTools: [],
        workspace: '/data/worktrees/parent-agent/sub_1',
      }),
    });

    // Turn one is left mid-stream: its pool entry is pinned.
    const first = agents.chat({ agentId, conversationId: 'sub_child', text: 'go' });
    expect((await first.next()).value).toMatchObject({ type: 'text_delta' });

    // The operator removes `bash`; a second turn arrives without the hub lease.
    grant = ['read'];
    const events: AgentEvent[] = [];
    for await (const event of agents.chat({
      agentId,
      conversationId: 'sub_child',
      text: 'overlapping',
    })) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error' });
    expect((events[0] as { error: Error }).error.message).toMatch(/still running/);
    // It did NOT run on the wide backend...
    expect(builtWith).toEqual([['read', 'bash']]);

    // ...and, the point of the finding: the entry was not relabelled, so once
    // the first turn finishes the next one rebuilds instead of matching.
    release();
    await drain(first);
    await drain(agents.chat({ agentId, conversationId: 'sub_child', text: 'after' }));
    expect(builtWith).toEqual([['read', 'bash'], ['read']]);
  });

  it('reuses the warm child entry when the grant is unchanged', async () => {
    let runtimeCalls = 0;
    const { agents, agentId } = makeChildAgents({
      childRuntime: async () => {
        runtimeCalls++;
        return {
          backend: childBackend(),
          resolveConfig: () => ({ model: 'test/child-model', systemPrompt: 'child' }),
          workspace: '/data/worktrees/parent-agent/sub_1',
        };
      },
      childAttachOptions: () => ({
        orchestratorModel: 'test/child-model',
        orchestratorFallbackModels: undefined,
        orchestratorTools: ['read'],
        orchestratorMcpTools: [],
        workspace: '/data/worktrees/parent-agent/sub_1',
      }),
    });

    await drain(agents.chat({ agentId, conversationId: 'sub_child', text: 'go' }));
    await drain(agents.chat({ agentId, conversationId: 'sub_child', text: 'again' }));

    expect(runtimeCalls).toBe(1);
  });

  it('refuses a spec-less child turn even when its pool entry is still WARM', async () => {
    // The regression this covers: `childRuntime` only runs on a pool MISS, so a
    // guard that lives only there stops firing the moment the entry is cached —
    // exactly the state a FINISHED child is in (its spec is dropped on terminal,
    // its warm backend is left to the pool's LRU).
    let specLive = true;
    let runtimeCalls = 0;
    const { agents, agentId, attaches } = makeChildAgents({
      childRuntime: async () => {
        runtimeCalls++;
        if (!specLive) throw new Error('no live spec');
        return {
          backend: childBackend(),
          resolveConfig: () => ({ model: 'test/child-model', systemPrompt: 'child' }),
          workspace: '/data/worktrees/parent-agent/sub_1',
        };
      },
      childAttachOptions: () => {
        if (!specLive) throw new Error('sub-agent conversation sub_child has no live spec');
        return {
          orchestratorModel: 'test/child-model',
          orchestratorFallbackModels: undefined,
          orchestratorTools: ['read'],
          orchestratorMcpTools: [],
          workspace: '/data/worktrees/parent-agent/sub_1',
        };
      },
    });

    // Turn one warms the entry while the spec is live.
    await drain(agents.chat({ agentId, conversationId: 'sub_child', text: 'go' }));
    expect(runtimeCalls).toBe(1);

    // The child finishes: its spec is gone, its pool entry is not.
    specLive = false;
    const events: AgentEvent[] = [];
    for await (const event of agents.chat({
      agentId,
      conversationId: 'sub_child',
      text: 'a user typed into the finished child',
    })) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error' });
    expect((events[0] as { error: Error }).error.message).toMatch(/no live spec/);
    // The refusal beat the pool: no second turn attached with the AGENT's grant
    // (whose workspace is the real repo, outside the child's worktree).
    expect(attaches).toHaveLength(1);
    expect(runtimeCalls).toBe(1);
  });
});
