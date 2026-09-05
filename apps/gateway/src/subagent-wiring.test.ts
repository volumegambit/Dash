import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type {
  AgentBackend,
  AgentState,
  DashAgentConfig,
  DashAgentConfigResolver,
  PiAgentBackendOptions,
} from '@dash/agent';
import type { SwarmExtraTool, WorkerSpec } from '@dash/swarm';
import { AgentRegistry, type AgentSwarmConfig } from './agent-registry.js';
import { DEFAULT_SWARM_CONFIG, resolveSwarmConfig } from './config.js';
import {
  type ChildBackendDeps,
  buildChildBackendOptions,
  buildWorkerPreamble,
  createGatewayWorkerFactory,
  workerSessionDir,
} from './subagent-wiring.js';

/**
 * Capture every resolver `createGatewayWorkerFactory` hands to `DashAgent`,
 * so the factory's *actual* static config resolver can be invoked and
 * inspected without booting pi. `PiAgentBackend` is stubbed for the same
 * reason; everything else in @dash/agent stays real.
 */
const captured = vi.hoisted(() => ({
  resolvers: [] as DashAgentConfigResolver[],
  states: [] as AgentState[],
  options: [] as unknown[],
}));

vi.mock('@dash/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dash/agent')>();
  class FakePiAgentBackend {
    readonly name = 'piagent';
    static fromOptions(options: unknown): FakePiAgentBackend {
      captured.options.push(options);
      return new FakePiAgentBackend();
    }
    async start(): Promise<void> {}
    run(state: AgentState): AsyncGenerator<never> {
      captured.states.push(state);
      return (async function* empty() {})();
    }
    abort(): void {}
    async stop(): Promise<void> {}
  }
  class RecordingDashAgent extends actual.DashAgent {
    constructor(backend: AgentBackend, resolver: DashAgentConfigResolver) {
      super(backend, resolver);
      captured.resolvers.push(resolver);
    }
  }
  return { ...actual, PiAgentBackend: FakePiAgentBackend, DashAgent: RecordingDashAgent };
});

function makeSpec(overrides: Partial<WorkerSpec> = {}): WorkerSpec {
  const askOrchestrator: SwarmExtraTool = {
    name: 'ask_orchestrator',
    label: 'Ask orchestrator',
    description: 'Ask the orchestrator a blocking question.',
    parameters: {},
    async execute() {
      return { content: [{ type: 'text', text: 'ok' }] };
    },
  };
  return {
    agentId: 'agent-id-1',
    agentName: 'researcher',
    runId: 'run-abc',
    workerId: 'w-01',
    role: 'Scout',
    brief: 'Find all TODO comments in the repo and list them.',
    model: 'anthropic/claude-sonnet-4-20250514',
    workspace: '/tmp/ws',
    tools: ['bash', 'read_file'],
    extraTools: [askOrchestrator],
    ...overrides,
  };
}

const parentSkillDirs = ['/parent/skills', '/plugin/skills'];
const parentSkillFiles = [{ file: '/plugin/commands/triage.md', namespace: 'demo' }];
const hookRunner = {
  hasHooks: true,
  runPreToolUse: async () => ({ block: false }),
  runPostToolUse: async () => ({ block: false }),
  runSessionStart: async () => ({}),
  runStop: async () => ({}),
};
const pluginModelCatalog = { resolve: () => null };
/** Structural stand-in for the gateway's shared McpManager. */
// biome-ignore lint/suspicious/noExplicitAny: only identity is asserted
const mcpManager = { getTools: () => [] } as any;

const deps: ChildBackendDeps = {
  credentialProvider: async () => ({ anthropic: 'sk-test' }),
  dataDir: '/data/dir',
  mcpManager,
  pluginModelCatalog,
  hookRunner,
  getParentSkillDirs: () => parentSkillDirs,
  getExtraSkillFiles: () => parentSkillFiles,
};

describe('buildWorkerPreamble', () => {
  it('contains role, workerId, the three rules, and the brief verbatim', () => {
    const spec = makeSpec();
    const preamble = buildWorkerPreamble(spec);
    expect(preamble).toContain('You are "Scout" (worker w-01)');
    expect(preamble).toContain('an ephemeral worker agent in a swarm run by an orchestrator');
    expect(preamble).toContain('put your full findings in your FINAL message');
    expect(preamble).toContain('call the ask_orchestrator tool once');
    expect(preamble).toContain('You share the workspace with other workers');
    expect(preamble).toContain('# Task\nFind all TODO comments in the repo and list them.');
  });

  it('ends with the # Task heading immediately followed by the brief', () => {
    const spec = makeSpec({ brief: 'BRIEF_BODY' });
    expect(buildWorkerPreamble(spec).endsWith('# Task\nBRIEF_BODY')).toBe(true);
  });

  it('preamble uses subagent identity and definition body when present', () => {
    const spec = makeSpec({
      workerId: 'w1',
      subagentType: 'Explore',
      name: 'mapper',
      description: 'map',
      systemPrompt: 'BODY',
      depth: 1,
      brief: 'map it',
    });
    const text = buildWorkerPreamble(spec);
    expect(text).toContain('You are "mapper", an Explore agent (id w1, depth 1)');
    expect(text).toContain('BODY');
    expect(text).toContain('# Task\nmap it');
    expect(text).not.toContain('ephemeral worker agent in a swarm');
  });

  it('legacy spawn_worker specs keep the old preamble verbatim', () => {
    const spec = makeSpec({ workerId: 'w1', role: 'lister' });
    expect(buildWorkerPreamble(spec)).toMatch(
      /^You are "lister" \(worker w1\), an ephemeral worker agent in a swarm/,
    );
  });

  it('picks the article from the type name and defaults name/depth', () => {
    const plan = buildWorkerPreamble(makeSpec({ workerId: 'w2', subagentType: 'Plan' }));
    expect(plan).toContain('You are "Plan", a Plan agent (id w2, depth 1)');
    const generic = buildWorkerPreamble(
      makeSpec({ workerId: 'w3', subagentType: 'general-purpose', name: 'gp', depth: 2 }),
    );
    expect(generic).toContain('You are "gp", a general-purpose agent (id w3, depth 2)');
  });

  it('omits the definition body cleanly when the spec has none', () => {
    const text = buildWorkerPreamble(makeSpec({ subagentType: 'Explore', brief: 'B' }));
    expect(text.endsWith('# Task\nB')).toBe(true);
    expect(text).not.toContain('\n\n\n');
  });
});

describe('createGatewayWorkerFactory config resolver', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'swarm-factory-'));
    captured.resolvers.length = 0;
    captured.states.length = 0;
    captured.options.length = 0;
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function resolveFor(spec: WorkerSpec): Promise<DashAgentConfig> {
    const factory = createGatewayWorkerFactory({ ...deps, dataDir: dir });
    await factory(spec);
    const resolver = captured.resolvers.at(-1);
    if (!resolver) throw new Error('factory did not construct a DashAgent');
    return resolver();
  }

  /**
   * The factory seam: without this, a regression that constructed the backend
   * with (say) an unconditional `mcpManager` would pass every other test here,
   * because they all check `buildChildBackendOptions` in isolation.
   */
  it('hands PiAgentBackend.fromOptions exactly what buildChildBackendOptions built', async () => {
    const spec = makeSpec({ mcpTools: ['github__pr'] });
    const factoryDeps = { ...deps, dataDir: dir };
    const factory = createGatewayWorkerFactory(factoryDeps);
    await factory(spec);
    expect(captured.options.at(-1)).toEqual(buildChildBackendOptions(spec, factoryDeps));
  });

  it('does not pass the mcpManager to a child with no MCP grant', async () => {
    const factory = createGatewayWorkerFactory({ ...deps, dataDir: dir });
    await factory(makeSpec());
    expect((captured.options.at(-1) as PiAgentBackendOptions).mcpManager).toBeUndefined();
  });

  it('skipMemory children get a resolver that marks memory off', async () => {
    const config = await resolveFor(makeSpec({ skipMemory: true }));
    expect(config.memory).toEqual({ enabled: false, readOnly: true });
  });

  it('normal children get a resolver with memory on', async () => {
    const config = await resolveFor(makeSpec());
    expect(config.memory).toEqual({ enabled: true, readOnly: true });
    expect(config.model).toBe('anthropic/claude-sonnet-4-20250514');
    expect(config.systemPrompt).toBe(buildWorkerPreamble(makeSpec()));
  });

  /**
   * Ruling 1: the `memory.enabled` flag is INERT unless the child config also
   * carries a `workspace` — `DashAgent.chat` gates the preamble on BOTH. These
   * two drive the real factory end to end (real DashAgent, real
   * buildMemoryPreamble, a real MEMORY.md on disk) and read the system prompt
   * the backend was actually handed.
   */
  async function systemPromptFor(spec: WorkerSpec): Promise<string> {
    const factory = createGatewayWorkerFactory({ ...deps, dataDir: dir });
    const worker = await factory(spec);
    for await (const _ of worker.chat('go')) {
      /* the fake backend yields nothing */
    }
    const state = captured.states.at(-1);
    if (!state) throw new Error('the worker backend never ran');
    return state.systemPrompt;
  }

  it('a general-purpose child reads the project MEMORY.md', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'swarm-ws-'));
    try {
      await writeFile(join(workspace, 'MEMORY.md'), '- 2026-09-05: ship the thing.\n');
      const prompt = await systemPromptFor(
        makeSpec({ subagentType: 'general-purpose', workspace }),
      );
      expect(prompt).toContain('ship the thing.');
      expect(prompt).toContain('persistent memory file');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('but is never told to WRITE it — up to 8 children share one workspace', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'swarm-ws-'));
    try {
      await writeFile(join(workspace, 'MEMORY.md'), '- 2026-09-05: ship the thing.\n');
      const prompt = await systemPromptFor(
        makeSpec({ subagentType: 'general-purpose', workspace }),
      );
      expect(prompt).toContain('ship the thing.');
      // The default preamble's "use write_file to save memories" is a
      // whole-file overwrite; concurrent children would lose each other's
      // updates to a user-visible artifact.
      expect(prompt).not.toContain('write_file');
      expect(prompt).not.toContain('Proactively update');
      expect(prompt).toContain('READ-ONLY');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('a skipMemory child (Explore / Plan) does NOT read it', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'swarm-ws-'));
    try {
      await writeFile(join(workspace, 'MEMORY.md'), '- 2026-09-05: ship the thing.\n');
      const prompt = await systemPromptFor(
        makeSpec({ subagentType: 'Explore', skipMemory: true, workspace }),
      );
      expect(prompt).not.toContain('ship the thing.');
      expect(prompt).not.toContain('persistent memory file');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

describe('workerSessionDir', () => {
  it('resolves to sessions/<agentName>/.swarm/<runId>/<workerId>', () => {
    const spec = makeSpec();
    expect(workerSessionDir('/data/dir', spec)).toBe(
      resolve('/data/dir', 'sessions', 'researcher', '.swarm', 'run-abc', 'w-01'),
    );
  });
});

describe('buildChildBackendOptions (definition-driven path)', () => {
  it('passes config with the child model / preamble / tools', () => {
    const spec = makeSpec();
    const { config } = buildChildBackendOptions(spec, deps);
    expect(config.model).toBe(spec.model);
    expect(config.systemPrompt).toBe(buildWorkerPreamble(spec));
    expect(config.tools).toEqual(spec.tools);
    expect(config.mcpServers).toBeUndefined();
  });

  it('forwards the credential provider and the child session dir', () => {
    const spec = makeSpec();
    const options = buildChildBackendOptions(spec, deps);
    expect(options.providerApiKeysSource).toBe(deps.credentialProvider);
    expect(options.logger).toBe(deps.logger);
    expect(options.sessionDir).toBe(workerSessionDir(deps.dataDir, spec));
  });

  it('forwards ONLY spec.extraTools as the backend extra tools', () => {
    const spec = makeSpec();
    const options = buildChildBackendOptions(spec, deps);
    expect(options.extraTools).toBe(spec.extraTools);
    expect(options.extraTools?.length).toBe(1);
  });

  it('forwards a provided logger', () => {
    const logger = { info() {}, warn() {}, error() {} };
    const spec = makeSpec();
    expect(buildChildBackendOptions(spec, { ...deps, logger }).logger).toBe(logger);
  });

  // --- Ruling 3: load_skill must actually resolve for a granted child ------

  it('gives the child the parent skill dirs and extra skill files', () => {
    const options = buildChildBackendOptions(makeSpec(), deps);
    expect(options.config.skills?.paths).toEqual(parentSkillDirs);
    expect(options.extraSkillFiles).toEqual(parentSkillFiles);
  });

  it('never gives the child a writable managed skills dir', () => {
    // create_skill / install_skill / remove_skill all gate on managedSkillsDir
    // in buildCustomTools, so leaving it undefined is what makes the child
    // read-only over skills — no allow-list entry can re-enable them.
    expect(buildChildBackendOptions(makeSpec(), deps).managedSkillsDir).toBeUndefined();
    const greedy = makeSpec({ tools: ['read', 'create_skill', 'install_skill', 'remove_skill'] });
    expect(buildChildBackendOptions(greedy, deps).managedSkillsDir).toBeUndefined();
  });

  // --- Ruling 4: the child inherits the parent's hook runner ---------------

  it('gives the child the parent hook runner and plugin model catalog', () => {
    const options = buildChildBackendOptions(makeSpec(), deps);
    expect(options.hookRunner).toBe(hookRunner);
    expect(options.pluginModelCatalog).toBe(pluginModelCatalog);
  });

  // --- Ruling 2: the MCP half stops being dormant --------------------------

  it('grants the mcpManager plus a server + tool allow-list when spec.mcpTools is set', () => {
    const spec = makeSpec({ mcpTools: ['github__pr', 'github__issue'] });
    const { config, mcpManager: manager } = buildChildBackendOptions(spec, deps);
    expect(manager).toBe(mcpManager);
    expect(config.assignedMcpServers).toEqual(['github']);
    expect(config.mcpToolAllowlist).toEqual(['github__pr', 'github__issue']);
    // `mcp` is the gate buildCustomTools reads before registering ANY MCP tool.
    expect(config.tools).toContain('mcp');
  });

  it('derives one server entry per distinct prefix', () => {
    const spec = makeSpec({ mcpTools: ['github__pr', 'linear__issue', 'github__merge'] });
    const { config } = buildChildBackendOptions(spec, deps);
    expect(config.assignedMcpServers).toEqual(['github', 'linear']);
  });

  it('a child with no mcpTools gets no manager, no servers and no mcp gate', () => {
    const { config, mcpManager: manager } = buildChildBackendOptions(makeSpec(), deps);
    expect(manager).toBeUndefined();
    expect(config.assignedMcpServers).toBeUndefined();
    expect(config.mcpToolAllowlist).toBeUndefined();
    expect(config.tools).not.toContain('mcp');
  });

  it('an empty mcpTools array is treated as no MCP at all', () => {
    const { config, mcpManager: manager } = buildChildBackendOptions(
      makeSpec({ mcpTools: [] }),
      deps,
    );
    expect(manager).toBeUndefined();
    expect(config.tools).not.toContain('mcp');
  });

  it('never gives the child the MCP MANAGEMENT slots', () => {
    // mcp_add_server / mcp_list_servers / mcp_remove_server all require BOTH
    // mcpConfigStore and mcpAgentContext; withholding them makes the whole
    // management family unreachable for a child, however its tools list reads.
    const spec = makeSpec({
      mcpTools: ['github__pr'],
      tools: ['read', 'mcp_add_server', 'mcp_remove_server'],
    });
    const options = buildChildBackendOptions(spec, deps);
    expect(options.mcpConfigStore).toBeUndefined();
    expect(options.mcpAgentContext).toBeUndefined();
  });

  it('the tool allow-list is exactly the resolved grant, never the whole server', () => {
    // The B4 invariant, restated for MCP: `github__pr` must not drag
    // `github__merge` along just because they share a server.
    const spec = makeSpec({ mcpTools: ['github__pr'] });
    const { config } = buildChildBackendOptions(spec, deps);
    expect(config.mcpToolAllowlist).toEqual(['github__pr']);
    expect(config.mcpToolAllowlist).not.toContain('github__merge');
  });
});

describe('buildChildBackendOptions memory policy', () => {
  it('sets the child workspace so the memory preamble can resolve', () => {
    const spec = makeSpec({ workspace: '/ws/project' });
    expect(buildChildBackendOptions(spec, deps).config.workspace).toBe('/ws/project');
  });

  it('marks memory off for skipMemory children and on for the rest', () => {
    expect(buildChildBackendOptions(makeSpec({ skipMemory: true }), deps).config.memory).toEqual({
      enabled: false,
      readOnly: true,
    });
    expect(buildChildBackendOptions(makeSpec(), deps).config.memory).toEqual({
      enabled: true,
      readOnly: true,
    });
  });

  it('every child is read-only over memory, whatever its type', () => {
    for (const type of ['general-purpose', 'Explore', 'Plan', undefined]) {
      const options = buildChildBackendOptions(makeSpec({ subagentType: type }), deps);
      expect(options.config.memory?.readOnly).toBe(true);
    }
  });
});

describe('AgentRegistry swarm block round-trip', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'swarm-registry-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('persists and reloads a swarm block on an agent config', async () => {
    const filePath = join(dir, 'agents.json');
    const swarm: AgentSwarmConfig = {
      enabled: true,
      maxConcurrentWorkers: 4,
      maxWorkersPerRun: 12,
      maxSteersPerWorker: 5,
      maxRunSeconds: 900,
      allowedModels: ['anthropic/claude-sonnet-4-20250514'],
    };
    const registry = new AgentRegistry(filePath);
    const entry = registry.register({
      name: 'orchestrator',
      model: 'anthropic/claude-sonnet-4-20250514',
      systemPrompt: 'You coordinate.',
      swarm,
    });
    await registry.save();

    const reloaded = new AgentRegistry(filePath);
    await reloaded.load();
    const got = reloaded.get(entry.id);
    expect(got?.config.swarm).toEqual(swarm);
  });

  it('round-trips a swarm block updated via update()', async () => {
    const filePath = join(dir, 'agents.json');
    const registry = new AgentRegistry(filePath);
    const entry = registry.register({
      name: 'orchestrator',
      model: 'm',
      systemPrompt: 's',
    });
    registry.update(entry.id, { swarm: { enabled: false, maxRunSeconds: 60 } });
    await registry.save();

    const reloaded = new AgentRegistry(filePath);
    await reloaded.load();
    expect(reloaded.get(entry.id)?.config.swarm).toEqual({
      enabled: false,
      maxRunSeconds: 60,
    });
  });
});

describe('resolveSwarmConfig (gateway defaults merge)', () => {
  it('returns the built-in defaults when no overrides', () => {
    expect(resolveSwarmConfig()).toEqual(DEFAULT_SWARM_CONFIG);
    expect(DEFAULT_SWARM_CONFIG.maxConcurrentWorkersGlobal).toBe(16);
    expect(DEFAULT_SWARM_CONFIG.defaults).toEqual({
      maxConcurrentWorkers: 8,
      maxWorkersPerRun: 24,
      maxSteersPerWorker: 10,
      maxRunSeconds: 1800,
    });
  });

  it('lets a user override the global ceiling while defaults stay', () => {
    const merged = resolveSwarmConfig({ maxConcurrentWorkersGlobal: 32 });
    expect(merged.maxConcurrentWorkersGlobal).toBe(32);
    expect(merged.defaults).toEqual(DEFAULT_SWARM_CONFIG.defaults);
  });

  it('fills unset defaults fields individually (deep-merge)', () => {
    const merged = resolveSwarmConfig({ defaults: { maxConcurrentWorkers: 2 } });
    expect(merged.defaults.maxConcurrentWorkers).toBe(2);
    // The rest fall back to the built-in defaults.
    expect(merged.defaults.maxWorkersPerRun).toBe(24);
    expect(merged.defaults.maxSteersPerWorker).toBe(10);
    expect(merged.defaults.maxRunSeconds).toBe(1800);
  });

  it('does not mutate the shared DEFAULT_SWARM_CONFIG', () => {
    resolveSwarmConfig({ maxConcurrentWorkersGlobal: 99, defaults: { maxRunSeconds: 1 } });
    expect(DEFAULT_SWARM_CONFIG.maxConcurrentWorkersGlobal).toBe(16);
    expect(DEFAULT_SWARM_CONFIG.defaults.maxRunSeconds).toBe(1800);
  });
});
