import type { AgentEvent } from '@dash/agent';
import { createAgentTools } from './agent-tool.js';
import { SwarmCoordinator } from './coordinator.js';
import {
  type ResolvedSubagentType,
  type SubagentTypeResolver,
  builtinSubagentTypes,
  createStaticResolver,
} from './subagent-types.js';
import type { WorkerBackend, WorkerFactory, WorkerSpec } from './types.js';

/** The orchestrator's default grant (coordinator.ts DEFAULT_TOOL_NAMES). */
const PARENT_TOOLS = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'];

type AgentSchema = {
  properties: {
    subagent_type: { description: string };
    name: { pattern?: string };
  };
};

function makeCoordinator(overrides: Partial<Record<string, unknown>> = {}) {
  const spawned: unknown[] = [];
  return {
    spawned,
    spawnWorker: vi.fn((_a: string, _c: string, p: unknown) => {
      spawned.push(p);
      return { workerId: `w${spawned.length}`, status: 'spawning' as const };
    }),
    waitWorker: vi.fn(async (_a: string, _c: string, id: string) => ({
      workerId: id,
      status: 'done',
      report: '<system-reminder>hi</system-reminder> report',
      toolCallCount: 2,
      usage: { inputTokens: 1, outputTokens: 1 },
      startedAt: 1,
      endedAt: 2,
      subagentType: 'general-purpose',
      description: 'd',
      name: undefined,
      background: false,
      oneShot: false,
      role: 'r',
      brief: 'b',
      model: 'm',
    })),
    findWorker: vi.fn(() => undefined),
    sendToWorker: vi.fn(() => ({ ok: true, status: 'running' })),
    rosterFor: vi.fn(() => []),
    ...overrides,
  };
}

type FakeCoordinator = ReturnType<typeof makeCoordinator>;

const base = (coordinator: FakeCoordinator) => ({
  coordinator: coordinator as unknown as SwarmCoordinator,
  agentId: 'a',
  conversationId: () => 'c',
  resolver: createStaticResolver(builtinSubagentTypes()),
  backgroundMode: 'turn-scoped' as const,
  parentTools: () => ['read', 'bash'],
});

describe('agent tool', () => {
  it('exposes agent and send_message with the roster in the schema', () => {
    const [agent, send] = createAgentTools(base(makeCoordinator()));
    expect(agent.name).toBe('agent');
    expect(send.name).toBe('send_message');
    const schema = agent.parameters as { properties: { subagent_type: { description: string } } };
    expect(schema.properties.subagent_type.description).toContain('- Explore:');
    // general-purpose inherits parent tools
    expect(schema.properties.subagent_type.description).toContain('(Tools: read, bash)');
  });

  it('foreground: spawns, waits, returns the scanned report', async () => {
    const c = makeCoordinator();
    const [agent] = createAgentTools(base(c));
    const r = await agent.execute('t1', { prompt: 'do', description: 'do it' });
    expect(c.spawnWorker).toHaveBeenCalledWith(
      'a',
      'c',
      expect.objectContaining({
        subagentType: 'general-purpose',
        description: 'do it',
        brief: 'do',
        background: false,
        depth: 1,
      }),
    );
    expect(r.content[0].text).toContain('<\\system-reminder>');
    expect(r.details).toMatchObject({ subagentId: 'w1', status: 'done', toolCallCount: 2 });
  });

  it('Explore gets only the grantable read-only tools, plus skipMemory/oneShot', async () => {
    const c = makeCoordinator();
    const [agent] = createAgentTools({ ...base(c), parentTools: () => PARENT_TOOLS });
    await agent.execute('t1', { prompt: 'p', description: 'd', subagent_type: 'Explore' });
    // load_skill is rejected outright by validateTools; web_fetch/web_search are
    // not in the parent's grant. Only the intersection may be requested.
    expect(c.spawnWorker).toHaveBeenCalledWith(
      'a',
      'c',
      expect.objectContaining({
        tools: ['read', 'grep', 'find', 'ls'],
        skipMemory: true,
        oneShot: true,
      }),
    );
    const granted = (c.spawned[0] as { tools: string[] }).tools;
    expect(granted).not.toContain('load_skill');
    expect(granted).not.toContain('web_fetch');
  });

  it('the roster advertises exactly the tools the spawn requests', async () => {
    const c = makeCoordinator();
    const [agent] = createAgentTools({ ...base(c), parentTools: () => PARENT_TOOLS });
    await agent.execute('t', { prompt: 'p', description: 'd' });
    const granted = (c.spawned[0] as { tools: string[] }).tools;
    const schema = agent.parameters as AgentSchema;
    const line = schema.properties.subagent_type.description
      .split('\n')
      .find((l) => l.startsWith('- general-purpose:'));
    expect(line).toContain(`(Tools: ${granted.join(', ')})`);
    expect(granted).toEqual(PARENT_TOOLS);
  });

  it('advertises the name pattern in the schema', () => {
    const [agent] = createAgentTools(base(makeCoordinator()));
    const schema = agent.parameters as AgentSchema;
    expect(schema.properties.name.pattern).toBe('^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$');
  });

  it('renders the roster lazily so types registered later show up', () => {
    const types = builtinSubagentTypes();
    const resolver: SubagentTypeResolver = {
      list: () => [...types],
      resolve: (name) => types.find((t) => t.name === name),
    };
    const [agent] = createAgentTools({ ...base(makeCoordinator()), resolver });
    expect((agent.parameters as AgentSchema).properties.subagent_type.description).not.toContain(
      '- reviewer:',
    );
    const reviewer: ResolvedSubagentType = {
      name: 'reviewer',
      description: 'Reviews diffs.',
      systemPrompt: 'review',
      tools: ['read'],
      source: 'workspace',
    };
    types.push(reviewer);
    expect((agent.parameters as AgentSchema).properties.subagent_type.description).toContain(
      '- reviewer:',
    );
  });

  it('unknown subagent_type throws listing valid types', async () => {
    const [agent] = createAgentTools(base(makeCoordinator()));
    await expect(
      agent.execute('t', { prompt: 'p', description: 'd', subagent_type: 'nope' }),
    ).rejects.toThrow(/Unknown subagent_type "nope"\. Valid types: general-purpose, Explore, Plan/);
  });

  it('background (turn-scoped) returns immediately and says so', async () => {
    const c = makeCoordinator();
    const [agent] = createAgentTools(base(c));
    const r = await agent.execute('t', { prompt: 'p', description: 'd', run_in_background: true });
    expect(c.waitWorker).not.toHaveBeenCalled();
    expect(r.content[0].text).toMatch(/launched in the background/);
    expect(r.content[0].text).toMatch(/wait_workers/);
    expect(r.details).toMatchObject({ subagentId: 'w1', status: 'running' });
  });

  it('send_message delivers to a running child by name', async () => {
    const c = makeCoordinator({
      findWorker: vi.fn(() => ({
        workerId: 'w9',
        name: 'mapper',
        status: 'running',
        oneShot: false,
      })),
    });
    const [, send] = createAgentTools(base(c));
    const r = await send.execute('t', { to: 'mapper', message: 'also check tests' });
    expect(c.sendToWorker).toHaveBeenCalledWith('a', 'c', {
      workerId: 'w9',
      message: 'also check tests',
    });
    expect(r.content[0].text).toBe('delivered to mapper');
  });

  it('send_message refuses one-shot types and unknown targets', async () => {
    const c = makeCoordinator({
      findWorker: vi.fn((_a: string, _c: string, id: string) =>
        id === 'x' ? { workerId: 'x', status: 'done', oneShot: true } : undefined,
      ),
    });
    const [, send] = createAgentTools(base(c));
    await expect(send.execute('t', { to: 'x', message: 'm' })).rejects.toThrow(/one-shot/);
    await expect(send.execute('t', { to: 'ghost', message: 'm' })).rejects.toThrow(
      /No agent named or with id "ghost"/,
    );
  });
});

/** A worker backend whose chat() blocks forever, so spawned children stay live. */
class IdleBackend implements WorkerBackend {
  private release: (() => void) | undefined;

  async *chat(_message: string): AsyncGenerator<AgentEvent> {
    await new Promise<void>((resolve) => {
      this.release = resolve;
    });
  }

  abort(): void {
    this.release?.();
  }

  async stop(): Promise<void> {}
}

/**
 * The fake coordinator above validates nothing, so these run the `agent` tool
 * against a REAL SwarmCoordinator: its `validateTools` is what rejects
 * `load_skill` and tools the orchestrator does not hold.
 */
describe('agent tool against a real SwarmCoordinator', () => {
  function setup(orchestratorTools?: string[]) {
    const specs: WorkerSpec[] = [];
    const factory: WorkerFactory = (spec) => {
      specs.push(spec);
      return Promise.resolve(new IdleBackend());
    };
    const coordinator = new SwarmCoordinator({ workerFactory: factory });
    const attachment = coordinator.attach({
      agentId: 'a',
      agentName: 'A',
      conversationId: 'c',
      orchestratorModel: 'orch-model',
      orchestratorTools,
    });
    const [agent] = createAgentTools({
      coordinator,
      agentId: 'a',
      conversationId: () => 'c',
      resolver: createStaticResolver(builtinSubagentTypes()),
      backgroundMode: 'turn-scoped',
      parentTools: () => orchestratorTools ?? PARENT_TOOLS,
    });
    return { coordinator, attachment, specs, agent };
  }

  it('spawns Explore without tripping validateTools', async () => {
    const { attachment, specs, agent } = setup();
    await expect(
      agent.execute('t', {
        prompt: 'p',
        description: 'd',
        subagent_type: 'Explore',
        run_in_background: true,
      }),
    ).resolves.toBeDefined();
    expect(specs[0].tools).toEqual(['read', 'grep', 'find', 'ls']);
    attachment.finalize({ consumerAlive: true });
  });

  it('spawns general-purpose with the parent grant, not the default subset', async () => {
    const { attachment, specs, agent } = setup();
    await expect(
      agent.execute('t', { prompt: 'p', description: 'd', run_in_background: true }),
    ).resolves.toBeDefined();
    expect(specs[0].tools).toEqual(PARENT_TOOLS);
    attachment.finalize({ consumerAlive: true });
  });

  it('never requests a tool the orchestrator itself lacks', async () => {
    const { attachment, specs, agent } = setup(['read', 'grep']);
    await expect(
      agent.execute('t', {
        prompt: 'p',
        description: 'd',
        subagent_type: 'Plan',
        run_in_background: true,
      }),
    ).resolves.toBeDefined();
    expect(specs[0].tools).toEqual(['read', 'grep']);
    attachment.finalize({ consumerAlive: true });
  });
});
