import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AgentBackend, DashAgentConfig, DashAgentConfigResolver } from '@dash/agent';
import type { SwarmExtraTool, WorkerSpec } from '@dash/swarm';
import { AgentRegistry, type AgentSwarmConfig } from './agent-registry.js';
import { DEFAULT_SWARM_CONFIG, resolveSwarmConfig } from './config.js';
import {
  type GatewayWorkerFactoryDeps,
  buildWorkerBackendArgs,
  buildWorkerPreamble,
  createGatewayWorkerFactory,
  workerSessionDir,
} from './swarm-wiring.js';

/**
 * Capture every resolver `createGatewayWorkerFactory` hands to `DashAgent`,
 * so the factory's *actual* static config resolver can be invoked and
 * inspected without booting pi. `PiAgentBackend` is stubbed for the same
 * reason; everything else in @dash/agent stays real.
 */
const captured = vi.hoisted(() => ({ resolvers: [] as DashAgentConfigResolver[] }));

vi.mock('@dash/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dash/agent')>();
  class FakePiAgentBackend {
    async start(): Promise<void> {}
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

const deps: GatewayWorkerFactoryDeps = {
  credentialProvider: async () => ({ anthropic: 'sk-test' }),
  dataDir: '/data/dir',
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

  it('skipMemory children get a resolver that marks memory off', async () => {
    const config = await resolveFor(makeSpec({ skipMemory: true }));
    expect(config.memory).toEqual({ enabled: false });
  });

  it('normal children get a resolver with memory on', async () => {
    const config = await resolveFor(makeSpec());
    expect(config.memory).toEqual({ enabled: true });
    expect(config.model).toBe('anthropic/claude-sonnet-4-20250514');
    expect(config.systemPrompt).toBe(buildWorkerPreamble(makeSpec()));
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

describe('buildWorkerBackendArgs (stripped path)', () => {
  it('passes config with worker model / preamble / tools only', () => {
    const spec = makeSpec();
    const args = buildWorkerBackendArgs(spec, deps);
    const config = args[0];
    expect(config.model).toBe(spec.model);
    expect(config.systemPrompt).toBe(buildWorkerPreamble(spec));
    expect(config.tools).toBe(spec.tools);
    // No MCP/skills leak into the config object either.
    expect(config.mcpServers).toBeUndefined();
    expect(config.skills).toBeUndefined();
  });

  it('forwards the credential provider and the worker session dir', () => {
    const spec = makeSpec();
    const args = buildWorkerBackendArgs(spec, deps);
    expect(args[1]).toBe(deps.credentialProvider); // providerApiKeysSource
    expect(args[2]).toBe(deps.logger); // logger (undefined here)
    expect(args[3]).toBe(workerSessionDir(deps.dataDir, spec)); // sessionDir
  });

  it('strips every MCP / skills / hooks / model-catalog slot to undefined', () => {
    const spec = makeSpec();
    const args = buildWorkerBackendArgs(spec, deps);
    expect(args[4]).toBeUndefined(); // managedSkillsDir
    expect(args[5]).toBeUndefined(); // mcpManager
    expect(args[6]).toBeUndefined(); // mcpConfigStore
    expect(args[7]).toBeUndefined(); // mcpAgentContext
    expect(args[9]).toBeUndefined(); // extraSkillFiles / command files
    expect(args[10]).toBeUndefined(); // hookRunner
    expect(args[11]).toBeUndefined(); // pluginModelCatalog
  });

  it('forwards ONLY spec.extraTools as the backend extra tools', () => {
    const spec = makeSpec();
    const args = buildWorkerBackendArgs(spec, deps);
    // Same array reference — the coordinator-built ask_orchestrator tool.
    expect(args[8]).toBe(spec.extraTools);
    expect((args[8] as unknown[]).length).toBe(1);
  });

  it('forwards a provided logger', () => {
    const logger = { info() {}, warn() {}, error() {} };
    const spec = makeSpec();
    const args = buildWorkerBackendArgs(spec, { ...deps, logger });
    expect(args[2]).toBe(logger);
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
