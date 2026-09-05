import type { AgentEvent } from '@dash/agent';
import {
  type CreateAgentToolsOptions,
  SwarmCoordinator,
  type WorkerBackend,
  type WorkerFactory,
  type WorkerSpec,
  builtinSubagentTypes,
  createStaticResolver,
  parentBuiltinTools,
} from '@dash/swarm';
import { AgentRegistry, type GatewayAgentConfig } from './agent-registry.js';
import {
  childSkillWiring,
  createSubagentExtraTools,
  createSwarmGate,
  orchestratorMcpToolNames,
} from './subagent-tools.js';

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

/** The MCP tools the orchestrator itself holds, in the gateway's naming. */
const PARENT_MCP = ['github__pr', 'github__merge'];
/** Everything the shared manager exposes, across two servers. */
const ALL_MCP_TOOLS = ['github__pr', 'github__merge', 'linear__issue'];

function setup(
  parentTools: string[] | undefined = MC_PARENT_TOOLS,
  opts: { parentMcp?: string[]; attachMcp?: string[] } = {},
) {
  const parentMcp = opts.parentMcp ?? [];
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
    orchestratorMcpTools: opts.attachMcp ?? parentMcp,
  });
  const tools = createSubagentExtraTools({
    coordinator,
    agentId: 'a',
    agentConfig: config({ tools: parentTools }),
    // The roster the definition registry would serve. These tests are about the
    // parent-grant wiring, so the built-ins alone are the relevant set.
    resolver: createStaticResolver(builtinSubagentTypes()),
    conversationId: () => 'c',
    parentTools: () => parentTools,
    parentMcpTools: () => parentMcp,
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

describe('orchestrator MCP tools reach the spawn path', () => {
  it('puts the LIVE parent MCP list into the parent context', () => {
    setup(MC_PARENT_TOOLS, { parentMcp: PARENT_MCP });
    const opts = seenAgentToolOptions[0] as CreateAgentToolsOptions;
    expect(opts.parentContext?.().mcpTools).toEqual(PARENT_MCP);
  });

  it('a child inheriting the whole grant is spawned WITH the parent MCP tools', async () => {
    const { attachment, specs, agent } = setup(MC_PARENT_TOOLS, { parentMcp: PARENT_MCP });
    await agent.execute('t', { prompt: 'p', description: 'd', run_in_background: true });
    expect(specs[0].mcpTools).toEqual(PARENT_MCP);
    attachment.finalize({ consumerAlive: true });
  });

  it('BOTH halves must be threaded: the coordinator refuses a grant attach did not declare', async () => {
    // The context says the parent holds them; the attachment says it holds
    // none. validateMcpTools is the defence-in-depth re-check, and it fails
    // closed — this is exactly the regression an index.ts that wires only one
    // of the two call sites would ship.
    const { attachment, agent } = setup(MC_PARENT_TOOLS, {
      parentMcp: PARENT_MCP,
      attachMcp: [],
    });
    await expect(
      agent.execute('t', { prompt: 'p', description: 'd', run_in_background: true }),
    ).rejects.toThrow('the orchestrator does not have it');
    attachment.finalize({ consumerAlive: true });
  });

  it('a child cannot receive a server the operator never assigned to its parent', async () => {
    // End to end through the real helper: agent A is assigned only `linear`,
    // so a general-purpose child — which inherits the parent's WHOLE MCP set —
    // must not come out holding `github__merge`.
    const assigned = orchestratorMcpToolNames(
      {
        name: 'orch',
        model: 'orch-model',
        systemPrompt: 's',
        tools: MC_PARENT_TOOLS,
        mcpServers: ['linear'],
      },
      () => ALL_MCP_TOOLS,
    );
    const { attachment, specs, agent } = setup(MC_PARENT_TOOLS, { parentMcp: assigned });
    await agent.execute('t', { prompt: 'p', description: 'd', run_in_background: true });
    expect(specs[0].mcpTools).toEqual(['linear__issue']);
    expect(specs[0].mcpTools).not.toContain('github__merge');
    attachment.finalize({ consumerAlive: true });
  });

  it('a parent with no MCP tools still grants none', async () => {
    const { attachment, specs, agent } = setup();
    await agent.execute('t', { prompt: 'p', description: 'd', run_in_background: true });
    expect(specs[0].mcpTools).toBeUndefined();
    attachment.finalize({ consumerAlive: true });
  });
});

describe('createSwarmGate', () => {
  function gateFor(over: Partial<GatewayAgentConfig> = {}, tools = ALL_MCP_TOOLS) {
    const registry = new AgentRegistry();
    const { id } = registry.register({ name: 'orch', model: 'm', systemPrompt: 's', ...over });
    const coordinator = new SwarmCoordinator({
      workerFactory: () => Promise.resolve(new IdleBackend()),
    });
    const gate = createSwarmGate(coordinator, registry, () => tools);
    return { gate, id };
  }

  it('reports the orchestrator MCP tools for an agent that holds the mcp tool', () => {
    const { gate, id } = gateFor({ tools: ['read', 'mcp'] }, PARENT_MCP);
    expect(gate.orchestratorMcpTools?.(id)).toEqual(PARENT_MCP);
  });

  it('narrows to the servers the OPERATOR assigned to that agent', () => {
    // `config.mcpServers` is the per-agent assignment (patchMcpServers writes
    // it). Without this narrowing a general-purpose child — which has no
    // `tools:` key, so it inherits the parent's WHOLE MCP set — would receive
    // tools from servers the operator never assigned to its parent.
    const { gate, id } = gateFor({ tools: ['read', 'mcp'], mcpServers: ['linear'] });
    expect(gate.orchestratorMcpTools?.(id)).toEqual(['linear__issue']);
  });

  it('an agent assigned NO server holds no MCP tool', () => {
    const { gate, id } = gateFor({ tools: ['read', 'mcp'], mcpServers: [] });
    expect(gate.orchestratorMcpTools?.(id)).toEqual([]);
  });

  it('an agent with no assignment at all still sees the whole pool', () => {
    // Unset `mcpServers` is the legacy/standalone shape the gateway has always
    // treated as "everything"; narrowing it here would be a behaviour change
    // for existing agents rather than a fix.
    const { gate, id } = gateFor({ tools: ['read', 'mcp'] });
    expect(gate.orchestratorMcpTools?.(id)).toEqual(ALL_MCP_TOOLS);
  });

  it('reports none for an agent whose tool list omits mcp', () => {
    const { gate, id } = gateFor({ tools: ['read'] });
    expect(gate.orchestratorMcpTools?.(id)).toEqual([]);
  });

  it('reports none for the DEFAULT grant (mcp is not a default tool)', () => {
    const { gate, id } = gateFor();
    expect(gate.orchestratorMcpTools?.(id)).toEqual([]);
  });

  it('reports none for an unknown agent id', () => {
    const { gate } = gateFor({ tools: ['read', 'mcp'] });
    expect(gate.orchestratorMcpTools?.('nope')).toEqual([]);
  });
});

describe('childSkillWiring', () => {
  const wiring = {
    skillDirs: ['/plugins/alpha/skills', '/plugins/beta/skills'],
    commandFiles: [
      { file: '/plugins/alpha/commands/a.md', namespace: 'alpha' },
      { file: '/plugins/beta/commands/b.md', namespace: 'beta' },
    ],
    skillDirsByPlugin: {
      alpha: ['/plugins/alpha/skills'],
      beta: ['/plugins/beta/skills'],
    },
    agentDefFiles: [],
  };

  it('gives a child the parent skill paths, its plugin dirs and the managed dir', () => {
    const result = childSkillWiring(
      { name: 'orch', model: 'm', systemPrompt: 's', skills: { paths: ['/own/skills'] } },
      wiring,
      () => '/data/skills/orch',
    );
    expect(result.paths).toEqual([
      '/own/skills',
      '/plugins/alpha/skills',
      '/plugins/beta/skills',
      '/data/skills/orch',
    ]);
    expect(result.commandFiles).toEqual(wiring.commandFiles);
  });

  it('honours a narrowed plugins selection', () => {
    const result = childSkillWiring(
      { name: 'orch', model: 'm', systemPrompt: 's', plugins: ['alpha'] },
      wiring,
      () => '/data/skills/orch',
    );
    expect(result.paths).toEqual(['/plugins/alpha/skills', '/data/skills/orch']);
    expect(result.commandFiles).toEqual([wiring.commandFiles[0]]);
  });

  it('an agent configured plugins: [] gets NO plugin contribution', () => {
    const result = childSkillWiring(
      { name: 'orch', model: 'm', systemPrompt: 's', plugins: [] },
      wiring,
      () => '/data/skills/orch',
    );
    expect(result.paths).toEqual(['/data/skills/orch']);
    expect(result.commandFiles).toEqual([]);
  });

  it('FAILS CLOSED when the parent agent is gone', () => {
    // A deleted agent has no config. `filterPluginsByAgent(undefined, …)` means
    // ALL plugins, so a naive lookup miss would hand an orphaned child every
    // plugin's skills — strictly more than its parent ever had.
    expect(childSkillWiring(undefined, wiring, () => '/data/skills/orch')).toEqual({
      paths: [],
      commandFiles: [],
    });
  });
});
