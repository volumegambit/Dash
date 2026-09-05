import type { AgentEvent } from '@dash/agent';
import {
  type CreateAgentToolsOptions,
  SwarmCoordinator,
  type WorkerBackend,
  type WorkerFactory,
  type WorkerSpec,
  parentBuiltinTools,
} from '@dash/swarm';
import type { GatewayAgentConfig } from './agent-registry.js';
import { createSubagentExtraTools } from './subagent-tools.js';

/**
 * The gateway's sub-agent tool wiring. The point of these tests is that the
 * PRODUCTION caller reaches the real resolution API (`ParentToolContext`,
 * `parentBuiltinTools`, model aliases, the skill lookup) — a wiring gap here
 * leaves every one of those dormant while the unit tests inside `@dash/swarm`
 * still pass.
 */

/** Options `createSubagentExtraTools` handed to `createAgentTools`. */
const { seenAgentToolOptions } = vi.hoisted(() => ({
  seenAgentToolOptions: [] as unknown[],
}));

vi.mock('@dash/swarm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dash/swarm')>();
  return {
    ...actual,
    createAgentTools: (opts: unknown) => {
      seenAgentToolOptions.push(opts);
      return actual.createAgentTools(opts as CreateAgentToolsOptions);
    },
  };
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

function config(over: Partial<GatewayAgentConfig> = {}): GatewayAgentConfig {
  return { name: 'orch', model: 'orch-model', systemPrompt: 'sp', ...over };
}

/** A parent configured the way Mission Control lets an operator configure one. */
const MC_PARENT_TOOLS = ['read', 'bash', 'create_skill', 'mcp', 'mcp_add_server'];
/** What that parent can actually pass on: the managers are never inheritable. */
const INHERITABLE = ['read', 'bash', 'load_skill', 'task'];

function setup(parentTools: string[] | undefined = MC_PARENT_TOOLS) {
  const specs: WorkerSpec[] = [];
  const factory: WorkerFactory = (spec) => {
    specs.push(spec);
    return Promise.resolve(new IdleBackend());
  };
  const coordinator = new SwarmCoordinator({ workerFactory: factory });
  const attachment = coordinator.attach({
    agentId: 'a',
    agentName: 'orch',
    conversationId: 'c',
    orchestratorModel: 'orch-model',
    orchestratorTools: parentTools,
  });
  const tools = createSubagentExtraTools({
    coordinator,
    agentId: 'a',
    agentConfig: config({ tools: parentTools }),
    conversationId: () => 'c',
    parentTools: () => parentTools,
    parentModel: () => 'orch-model',
    listSkills: async () => [{ name: 'house-style', content: 'Two spaces.' }],
  });
  const agent = tools.find((t) => t.name === 'agent');
  if (!agent) throw new Error('the agent tool was not injected');
  return { coordinator, attachment, specs, agent };
}

beforeEach(() => {
  seenAgentToolOptions.length = 0;
});

describe('createSubagentExtraTools parent wiring', () => {
  it('re-exports the resolution API so a caller outside the package can build a context', () => {
    // Finding 4: unreachable exports are why the gateway stayed on the legacy
    // path. Importing them HERE, from the package entry point, is the check.
    expect(typeof parentBuiltinTools).toBe('function');
    expect(parentBuiltinTools(MC_PARENT_TOOLS)).toEqual(INHERITABLE);
  });

  it('hands the agent tool a filtered parent context, a model, aliases and skills', async () => {
    setup();
    const opts = seenAgentToolOptions[0] as CreateAgentToolsOptions;
    expect(opts.parentContext?.()).toEqual({
      builtinTools: INHERITABLE,
      mcpTools: [],
      depth: 0,
      maxDepth: 3,
    });
    expect(opts.parentModel?.()).toBe('orch-model');
    expect(opts.modelAliases?.()).toEqual({});
    await expect(opts.listSkills?.()).resolves.toEqual([
      { name: 'house-style', content: 'Two spaces.' },
    ]);
  });

  it('spawns for an agent configured with skill- and MCP-management tools', async () => {
    const { attachment, specs, agent } = setup();
    await expect(
      agent.execute('t', { prompt: 'p', description: 'd', run_in_background: true }),
    ).resolves.toBeDefined();
    expect(specs[0].tools).toEqual(INHERITABLE);
    attachment.finalize({ consumerAlive: true });
  });

  it('advertises only inheritable tools in the roster', () => {
    const { attachment, agent } = setup();
    const schema = agent.parameters as { properties: { subagent_type: { description: string } } };
    const line = schema.properties.subagent_type.description
      .split('\n')
      .find((l) => l.startsWith('- general-purpose:'));
    expect(line).toContain(`(Tools: ${INHERITABLE.join(', ')})`);
    attachment.finalize({ consumerAlive: true });
  });
});
