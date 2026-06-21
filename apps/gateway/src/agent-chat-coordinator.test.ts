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

describe('AgentChatCoordinator.listSkills', () => {
  it('returns an agent managed skill alongside the bundled tier', async () => {
    const managed = await mkdtemp(join(tmpdir(), 'dash-coord-skills-'));
    try {
      const skillDir = join(managed, 'my-skill');
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        join(skillDir, 'SKILL.md'),
        '---\nname: my-skill\ndescription: d\n---\n\nbody\n',
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
      });

      const skills = await agents.listSkills(id);
      expect(skills.map((s) => s.name)).toContain('my-skill');
      expect(skills.some((s) => s.source === 'bundled')).toBe(true);
      await agents.stop();
    } finally {
      await rm(managed, { recursive: true, force: true });
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

  it('refuses to remove a bundled skill', async () => {
    const managed = await mkdtemp(join(tmpdir(), 'dash-coord-skills-'));
    try {
      const { agents, id } = makeCoordinator(managed);
      const bundled = (await agents.listSkills(id)).find((s) => s.source === 'bundled');
      if (!bundled) throw new Error('expected a bundled skill');
      await expect(agents.removeSkill(id, bundled.name)).rejects.toMatchObject({ code: 'bundled' });
      await agents.stop();
    } finally {
      await rm(managed, { recursive: true, force: true });
    }
  });
});
