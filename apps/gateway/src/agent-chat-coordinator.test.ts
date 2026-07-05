import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentBackend, AgentEvent, AgentState, RunOptions } from '@dash/agent';
import { describe, expect, it } from 'vitest';
import { createAgentChatCoordinator } from './agent-chat-coordinator.js';
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
