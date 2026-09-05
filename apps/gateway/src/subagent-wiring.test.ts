import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type {
  AgentBackend,
  AgentEvent,
  AgentState,
  DashAgentConfig,
  DashAgentConfigResolver,
  PiAgentBackendOptions,
} from '@dash/agent';
import {
  type SwarmExtraTool,
  type WorkerBackend,
  WorkerHandle,
  type WorkerSpec,
} from '@dash/swarm';
import { AgentRegistry, type AgentSwarmConfig } from './agent-registry.js';
import { DEFAULT_SWARM_CONFIG, resolveSwarmConfig } from './config.js';
import {
  type ChildBackendDeps,
  buildChildBackendOptions,
  buildWorkerPreamble,
  cleanupWorktreeForSpec,
  createGatewayWorkerFactory,
  createWorktreeCleanupHook,
  workerSessionDir,
} from './subagent-wiring.js';
import { WORKTREE_REQUIRES_GIT, childWorktreePath } from './subagent-worktree.js';

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
  starts: [] as string[],
}));

vi.mock('@dash/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dash/agent')>();
  class FakePiAgentBackend {
    readonly name = 'piagent';
    static fromOptions(options: unknown): FakePiAgentBackend {
      captured.options.push(options);
      return new FakePiAgentBackend();
    }
    async start(workspace: string): Promise<void> {
      captured.starts.push(workspace);
    }
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
    captured.starts.length = 0;
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

const execFileAsync = promisify(execFile);
/** Own identity + no global config, so the suite runs the same everywhere. */
const GIT_IDENTITY = ['-c', 'user.email=t@example.com', '-c', 'user.name=Test'];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', [...GIT_IDENTITY, '-C', cwd, ...args]);
  return stdout;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

// Real `git` under a real temp repo: slower than vitest's 5s default.
describe('worktree isolation wiring', { timeout: 30_000 }, () => {
  let workspace: string;
  let dataDir: string;

  beforeEach(async () => {
    vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null');
    vi.stubEnv('GIT_CONFIG_SYSTEM', '/dev/null');
    captured.options.length = 0;
    captured.starts.length = 0;
    workspace = await mkdtemp(join(tmpdir(), 'wire-ws-'));
    dataDir = await mkdtemp(join(tmpdir(), 'wire-data-'));
    await git(workspace, 'init', '-b', 'main');
    await writeFile(join(workspace, 'base.txt'), 'base\n');
    await git(workspace, 'add', '-A');
    await git(workspace, 'commit', '-m', 'first');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(workspace, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  });

  it('an isolated child is started in its own worktree, not the parent workspace', async () => {
    const factory = createGatewayWorkerFactory({ ...deps, dataDir });
    const spec = makeSpec({ workspace, isolation: 'worktree' });
    const worker = await factory(spec);

    const expected = childWorktreePath({ dataDir, agentName: spec.agentName, childId: 'w-01' });
    expect(captured.starts.at(-1)).toBe(expected);
    expect((captured.options.at(-1) as PiAgentBackendOptions).config.workspace).toBe(expected);
    expect(worker.workspace).toBe(expected);
    expect(await pathExists(join(expected, 'base.txt'))).toBe(true);
  });

  it('a normal child still runs in the shared workspace', async () => {
    const factory = createGatewayWorkerFactory({ ...deps, dataDir });
    const worker = await factory(makeSpec({ workspace }));
    expect(captured.starts.at(-1)).toBe(workspace);
    expect(worker.workspace).toBe(workspace);
    expect(await pathExists(join(dataDir, 'worktrees'))).toBe(false);
  });

  it('an isolated child of a non-git workspace fails to spawn with the exact message', async () => {
    const plain = await mkdtemp(join(tmpdir(), 'wire-plain-'));
    try {
      const factory = createGatewayWorkerFactory({ ...deps, dataDir });
      await expect(factory(makeSpec({ workspace: plain, isolation: 'worktree' }))).rejects.toThrow(
        WORKTREE_REQUIRES_GIT,
      );
      // Nothing was constructed or started for the doomed child.
      expect(captured.starts).toHaveLength(0);
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });

  describe('cleanupWorktreeForSpec', () => {
    const finishedSpec = (over: Partial<WorkerSpec> = {}) => {
      const { extraTools: _extraTools, ...rest } = makeSpec({
        workspace,
        isolation: 'worktree',
        ...over,
      });
      return rest;
    };

    it('removes the worktree of a child that left it clean', async () => {
      const factory = createGatewayWorkerFactory({ ...deps, dataDir });
      const spec = makeSpec({ workspace, isolation: 'worktree' });
      await factory(spec);
      const path = childWorktreePath({ dataDir, agentName: spec.agentName, childId: 'w-01' });

      await expect(cleanupWorktreeForSpec(finishedSpec(), { dataDir })).resolves.toEqual({
        removed: true,
        path,
      });
      expect(await pathExists(path)).toBe(false);
    });

    /** Ruling 2: dirty means the child did work — keep it and surface the path. */
    it('keeps a dirty worktree and warns with its path', async () => {
      const factory = createGatewayWorkerFactory({ ...deps, dataDir });
      const spec = makeSpec({ workspace, isolation: 'worktree' });
      await factory(spec);
      const path = childWorktreePath({ dataDir, agentName: spec.agentName, childId: 'w-01' });
      await writeFile(join(path, 'findings.md'), '# work in progress\n');

      const warnings: string[] = [];
      await expect(
        cleanupWorktreeForSpec(finishedSpec(), { dataDir, warn: (m) => warnings.push(m) }),
      ).resolves.toEqual({ removed: false, path });
      expect(await pathExists(path)).toBe(true);
      expect(warnings.join('\n')).toContain(path);
    });

    /**
     * The gateway seam for the ignored-deliverable case. `docs/plans/` is
     * gitignored in this repo and is exactly where CLAUDE.md tells agents to
     * write plans, so a plan-writing child must keep its worktree and get the
     * path surfaced, the same as for a modified tracked file.
     */
    it('keeps a worktree holding a gitignored deliverable and warns with its path', async () => {
      await writeFile(join(workspace, '.gitignore'), 'docs/plans/\nnode_modules/\n');
      await git(workspace, 'add', '-A');
      await git(workspace, 'commit', '-m', 'ignore plans');
      const factory = createGatewayWorkerFactory({ ...deps, dataDir });
      const spec = makeSpec({ workspace, isolation: 'worktree' });
      await factory(spec);
      const path = childWorktreePath({ dataDir, agentName: spec.agentName, childId: 'w-01' });
      await mkdir(join(path, 'docs', 'plans'), { recursive: true });
      await writeFile(join(path, 'docs', 'plans', '2026-09-05-thing.md'), '# the plan\n');

      const warnings: string[] = [];
      await expect(
        cleanupWorktreeForSpec(finishedSpec(), { dataDir, warn: (m) => warnings.push(m) }),
      ).resolves.toEqual({ removed: false, path });
      expect(await pathExists(join(path, 'docs', 'plans', '2026-09-05-thing.md'))).toBe(true);
      expect(warnings.join('\n')).toContain('docs/plans');
    });

    /** A removal is never silent about what it took with it. */
    it('logs the disposable content a removal destroyed', async () => {
      await writeFile(join(workspace, '.gitignore'), 'node_modules/\n');
      await git(workspace, 'add', '-A');
      await git(workspace, 'commit', '-m', 'ignore deps');
      const factory = createGatewayWorkerFactory({ ...deps, dataDir });
      const spec = makeSpec({ workspace, isolation: 'worktree' });
      await factory(spec);
      const path = childWorktreePath({ dataDir, agentName: spec.agentName, childId: 'w-01' });
      await mkdir(join(path, 'node_modules'), { recursive: true });
      await writeFile(join(path, 'node_modules', 'x.js'), 'x\n');

      const warnings: string[] = [];
      await expect(
        cleanupWorktreeForSpec(finishedSpec(), { dataDir, warn: (m) => warnings.push(m) }),
      ).resolves.toEqual({ removed: true, path });
      expect(await pathExists(path)).toBe(false);
      expect(warnings.join('\n')).toContain('node_modules/');
    });

    it('does nothing for a child that was not isolated', async () => {
      const { extraTools: _extraTools, ...spec } = makeSpec({ workspace });
      await expect(cleanupWorktreeForSpec(spec, { dataDir })).resolves.toBeUndefined();
    });

    /**
     * A spawn that never got as far as creating the worktree (the non-git
     * refusal is the common case) still finalizes the worker, so cleanup runs
     * against a path that was never there. That is normal, not a warning.
     */
    it('says nothing when the worktree was never created', async () => {
      const warnings: string[] = [];
      await expect(
        cleanupWorktreeForSpec(finishedSpec({ workerId: 'never-created' }), {
          dataDir,
          warn: (m) => warnings.push(m),
        }),
      ).resolves.toBeUndefined();
      expect(warnings).toEqual([]);
    });

    it('logs rather than throws when the path is not a worktree at all', async () => {
      const path = childWorktreePath({ dataDir, agentName: 'researcher', childId: 'w-13' });
      await mkdir(path, { recursive: true });
      const warnings: string[] = [];
      await expect(
        cleanupWorktreeForSpec(finishedSpec({ workerId: 'w-13' }), {
          dataDir,
          warn: (m) => warnings.push(m),
        }),
      ).resolves.toBeUndefined();
      expect(warnings.join('\n')).toContain(path);
    });
  });

  /**
   * Ruling 5: the hook the swarm calls on EVERY terminal path. A cancelled
   * child must take its worktree down too, or every cancel leaks a directory.
   */
  it('the cleanup hook removes the worktree of a cancelled child', async () => {
    const factory = createGatewayWorkerFactory({ ...deps, dataDir });
    const spec = makeSpec({ workspace, isolation: 'worktree' });
    const worker = await factory(spec);
    const path = childWorktreePath({ dataDir, agentName: spec.agentName, childId: 'w-01' });
    expect(await pathExists(path)).toBe(true);

    const hook = createWorktreeCleanupHook({ dataDir });
    // Exactly what a cancel does: abort the child, then fire the terminal hook.
    worker.abort();
    const { extraTools: _extraTools, ...finished } = spec;
    await hook(finished);

    expect(await pathExists(path)).toBe(false);
  });

  it('the cleanup hook resolves rather than rejecting when git fails', async () => {
    const factory = createGatewayWorkerFactory({ ...deps, dataDir });
    await factory(makeSpec({ workspace, isolation: 'worktree' }));

    const warnings: string[] = [];
    const hook = createWorktreeCleanupHook({ dataDir, warn: (m) => warnings.push(m) });
    // The worktree is real and clean, but the repo it belongs to is gone: the
    // `git worktree remove` fails and must not escape as a rejection.
    const { extraTools: _extraTools, ...finished } = makeSpec({
      workspace: '/no/such/workspace',
      isolation: 'worktree',
    });
    await expect(hook(finished)).resolves.toBeUndefined();
    expect(warnings).not.toHaveLength(0);
  });

  /**
   * Ruling 2 of task B7. `max_turns` is the second terminal status produced by
   * a cooperative abort rather than by the child finishing, and the finalizer's
   * contract is that EVERY terminal path notifies the spawner. These two pin
   * that end to end — a real worktree, a real WorkerHandle tripping its cap,
   * and the real cleanup hook — so a future refactor that hand-rolls the
   * max_turns transition cannot silently start leaking a directory per capped
   * child.
   */
  describe('a child that trips maxTurns', () => {
    const EMPTY_USAGE = { inputTokens: 0, outputTokens: 0 };

    /** Yields a report, then more tool calls than `maxTurns` allows. */
    class CappedBackend implements WorkerBackend {
      abortCalls = 0;
      async *chat(): AsyncGenerator<AgentEvent> {
        yield { type: 'response', content: 'what I found so far', usage: EMPTY_USAGE };
        yield { type: 'tool_use_start', id: 't1', name: 'read_file' };
        yield { type: 'tool_use_start', id: 't2', name: 'read_file' };
        // Never reached: the handle finalizes on the event above.
        yield { type: 'response', content: 'a complete report', usage: EMPTY_USAGE };
      }
      abort(): void {
        this.abortCalls++;
      }
      async stop(): Promise<void> {}
    }

    async function runCapped(dir: string) {
      const factory = createGatewayWorkerFactory({ ...deps, dataDir: dir });
      const spec = makeSpec({ workspace, isolation: 'worktree', maxTurns: 1 });
      await factory(spec);
      const path = childWorktreePath({ dataDir: dir, agentName: spec.agentName, childId: 'w-01' });
      expect(await pathExists(path)).toBe(true);
      return { spec, path };
    }

    function startHandle(
      spec: WorkerSpec,
      backend: WorkerBackend,
      onFinished: (s: Omit<WorkerSpec, 'extraTools'>) => Promise<void>,
    ) {
      const { extraTools: _extraTools, ...handleSpec } = spec;
      const handle = new WorkerHandle({
        spec: handleSpec,
        backendPromise: Promise.resolve(backend),
        emit: () => {},
        maxSteers: 3,
        onTerminal: () => {},
        onFinished,
      });
      handle.start();
      return handle;
    }

    it('keeps its worktree for resumption even if clean', async () => {
      const { spec, path } = await runCapped(dataDir);
      const backend = new CappedBackend();
      const warnings: string[] = [];
      const handle = startHandle(
        spec,
        backend,
        createWorktreeCleanupHook({ dataDir, warn: (m) => warnings.push(m) }),
      );
      await handle.terminalPromise;

      expect(handle.status).toBe('max_turns');
      expect(backend.abortCalls).toBe(1);
      // A max_turns child is resumable, so its worktree must be kept to support
      // `send_message` resumes. This is true even if the worktree is clean.
      await vi.waitFor(() => expect(warnings).not.toHaveLength(0));
      expect(warnings.join('\n')).toContain('resumption');
      expect(await pathExists(path)).toBe(true);
    });

    it('keeps the worktree when it left work behind, and says where', async () => {
      const { spec, path } = await runCapped(dataDir);
      // A capped child is stopped MID-task: whatever it wrote is exactly the
      // partial output its report points at, so cleanup must not delete it.
      await writeFile(join(path, 'findings.md'), '# half the answer\n');

      const warnings: string[] = [];
      const handle = startHandle(
        spec,
        new CappedBackend(),
        createWorktreeCleanupHook({ dataDir, warn: (m) => warnings.push(m) }),
      );
      await handle.terminalPromise;

      expect(handle.status).toBe('max_turns');
      await vi.waitFor(() => expect(warnings).not.toHaveLength(0));
      expect(warnings.join('\n')).toContain(path);
      expect(await pathExists(path)).toBe(true);
      expect(await pathExists(join(path, 'findings.md'))).toBe(true);
    });
  });
});
