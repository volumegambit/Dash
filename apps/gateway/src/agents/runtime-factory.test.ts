import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PiAgentBackend, type PiAgentBackendOptions } from '@dash/agent';
import { McpManager } from '@dash/mcp';
import { createHookEngine } from '@dash/plugins';
import { type ProjectsDb, openProjectsDb } from '@dash/projects';
import { SwarmCoordinator, createStaticResolver } from '@dash/swarm';
import type { BackendFactoryConfig } from '../agent-chat-coordinator.js';
import { AgentRegistry } from '../agent-registry.js';
import { createFakeChildDriver } from '../fake-child-driver.js';
import { McpConfigStore } from '../mcp-store.js';
import type { PluginWiringState } from '../plugins-wiring.js';
import type { SubagentExtraToolsOptions } from '../subagent-tools.js';
import { createAgentRuntimeFactory, createRuntimeCredentialProvider } from './runtime-factory.js';

const { subagentInputs } = vi.hoisted(() => ({ subagentInputs: [] as unknown[] }));

vi.mock('../subagent-tools.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../subagent-tools.js')>();
  return {
    ...actual,
    createSubagentExtraTools: (options: SubagentExtraToolsOptions) => {
      subagentInputs.push(options);
      return actual.createSubagentExtraTools(options);
    },
  };
});

function wiring(revision = 'one'): PluginWiringState {
  return {
    skillDirs: [`/${revision}/alpha/skills`, `/${revision}/beta/skills`],
    skillDirsByPlugin: {
      alpha: [`/${revision}/alpha/skills`],
      beta: [`/${revision}/beta/skills`],
    },
    commandFiles: [
      { file: `/${revision}/alpha/commands/test.md`, namespace: 'alpha' },
      { file: `/${revision}/beta/commands/test.md`, namespace: 'beta' },
    ],
    agentDefFiles: [{ file: `/${revision}/alpha/agents/review.md`, namespace: 'alpha' }],
    hookEngine: createHookEngine([]),
    pluginModelCatalog: { resolve: () => null },
    mcpConfigs: [],
    pluginProviderConfigs: [],
    droppedProviderCollisions: [],
    pluginRecords: {},
  };
}

function localProvider(id: string, placeholderKey?: string) {
  return {
    pluginName: 'local',
    catalog: {
      id,
      label: id,
      credentialPrefix: id,
      baseUrl: 'http://localhost:11434/v1',
      api: 'openai-completions' as const,
      models: [],
      placeholderKey,
    },
  };
}

describe('runtime credentials', () => {
  it('refreshes before every read and observes key rotation, deletion and live placeholders', async () => {
    let current = wiring();
    current.pluginProviderConfigs = [localProvider('local', 'placeholder')];
    let keys: Record<string, string> = { anthropic: 'old', openai: 'delete-on-next-turn' };
    const order: string[] = [];
    const provider = createRuntimeCredentialProvider({
      credentialStore: {
        readProviderApiKeys: async () => {
          order.push('read');
          return { ...keys };
        },
      },
      oauthRefreshCoordinator: {
        refreshExpiring: async () => {
          order.push('refresh');
          keys.anthropic = 'refreshed';
        },
      },
      getWiringState: () => current,
    });

    expect(order).toEqual([]);
    expect(await provider()).toEqual({
      anthropic: 'refreshed',
      openai: 'delete-on-next-turn',
      local: 'placeholder',
    });
    keys = { local: 'stored-local' };
    current = wiring('two');
    current.pluginProviderConfigs = [
      localProvider('local', 'replacement'),
      localProvider('new-local', 'new-placeholder'),
      localProvider('requires-key'),
    ];
    expect(await provider()).toEqual({
      anthropic: 'refreshed',
      local: 'stored-local',
      'new-local': 'new-placeholder',
    });
    expect(order).toEqual(['refresh', 'read', 'refresh', 'read']);
  });
});

describe('parent runtime factory', () => {
  let dataDir: string;
  let projectsDb: ProjectsDb;
  let registry: AgentRegistry;
  let current: PluginWiringState;
  let constructed: PiAgentBackendOptions[];
  let backends: PiAgentBackend[];
  let mcpManager: McpManager;
  let mcpConfigStore: McpConfigStore;
  const credentialProvider = vi.fn(async () => ({}));
  let resolverFor = vi.fn(async (_agentId: string) => createStaticResolver([]));

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'runtime-factory-'));
    projectsDb = openProjectsDb(dataDir);
    registry = new AgentRegistry(join(dataDir, 'agents.json'));
    current = wiring();
    constructed = [];
    backends = [];
    subagentInputs.length = 0;
    mcpManager = new McpManager([]);
    mcpConfigStore = new McpConfigStore(join(dataDir, 'mcp'));
    resolverFor = vi.fn(async (_agentId: string) => createStaticResolver([]));
  });

  afterEach(async () => {
    projectsDb.db.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  function factory() {
    return createAgentRuntimeFactory({
      dataDir,
      registry,
      getWiringState: () => current,
      credentialProvider,
      mcpManager,
      mcpConfigStore,
      projectsDb,
      swarmCoordinator: new SwarmCoordinator({
        childDriver: createFakeChildDriver(async () => {
          throw new Error('This test must not run a child');
        }),
      }),
      subagentRosters: { resolverFor },
      listMcpToolNames: () => ['github__read', 'linear__read'],
      createBackend: (options) => {
        constructed.push(options);
        const backend = PiAgentBackend.fromOptions(options);
        backends.push(backend);
        return backend;
      },
    });
  }

  function register(overrides: Partial<BackendFactoryConfig> = {}) {
    return registry.register({
      name: 'parent-name',
      model: 'anthropic/claude-sonnet-4-5',
      systemPrompt: 'Parent prompt',
      ...overrides,
    });
  }

  it('reads each new wiring snapshot and preserves provider, skill and memory boundaries', async () => {
    const agent = register({
      plugins: ['alpha'],
      providers: ['anthropic'],
      tools: ['read'],
      fallbackModels: ['anthropic/claude-haiku-4-5'],
      skills: { paths: ['/own-skills'], urls: ['https://example.test/skill'] },
    });
    const memoryRuntime = { dir: join(dataDir, 'memory', agent.id), tools: false };
    const build = factory();
    const firstWiring = current;
    await build({ ...agent.config, memoryRuntime }, 'one', agent.id);
    current = wiring('two');
    await build({ ...agent.config, memoryRuntime }, 'two', agent.id);

    expect(constructed[0].config).toMatchObject({
      model: agent.config.model,
      systemPrompt: agent.config.systemPrompt,
      allowedProviders: ['anthropic'],
      fallbackModels: agent.config.fallbackModels,
      tools: ['read'],
      memory: memoryRuntime,
      skills: {
        paths: ['/own-skills', '/one/alpha/skills'],
        urls: ['https://example.test/skill'],
      },
    });
    expect(constructed[0].extraSkillFiles).toEqual([firstWiring.commandFiles[0]]);
    expect(constructed[0].hookRunner).toBe(firstWiring.hookEngine);
    expect(constructed[0].pluginModelCatalog).toBe(firstWiring.pluginModelCatalog);
    expect(constructed[1].config.skills?.paths).toEqual(['/own-skills', '/two/alpha/skills']);
    expect(constructed[1].hookRunner).toBe(current.hookEngine);
    expect(constructed[1].pluginModelCatalog).toBe(current.pluginModelCatalog);
    expect(constructed[0].sessionDir).toBe(join(dataDir, 'sessions', agent.name, 'one'));
    expect((await stat(constructed[0].sessionDir as string)).isDirectory()).toBe(true);
    expect(constructed[0].managedSkillsDir).toBe(join(dataDir, 'skills', agent.name));
    expect(constructed[0].providerApiKeysSource).toBe(credentialProvider);
    expect(credentialProvider).not.toHaveBeenCalled();
    expect(constructed[0].logger).toBeUndefined();
    expect(constructed[0].config.workspace).toBeUndefined();
    expect(resolverFor).toHaveBeenNthCalledWith(1, agent.id);
    expect(resolverFor).toHaveBeenNthCalledWith(2, agent.id);
  });

  it('respects empty plugin selection and disabled location, subagents and memory', async () => {
    const agent = register({
      plugins: [],
      subagents: { enabled: false },
      location: { enabled: false },
      memory: { enabled: false },
    });
    await factory()(agent.config, 'one', agent.id);
    const options = constructed[0];
    expect(resolverFor).not.toHaveBeenCalled();
    expect(options.config.memory).toBeUndefined();
    expect(options.config.skills?.paths).toEqual([]);
    expect(options.extraSkillFiles).toEqual([]);
    expect(backends[0].listExtraToolNames()).toContain('issues_create');
    expect(backends[0].listExtraToolNames()).not.toContain('agent');
    expect(backends[0].listExtraToolNames()).not.toContain('spawn_worker');
    expect(backends[0].listExtraToolNames()).not.toContain('get_location');
  });

  it('keeps projects session identity and client location late-bound across turns', async () => {
    const agent = register();
    await factory()(agent.config, 'construction-conversation', agent.id);
    const backend = backends[0];
    const tools = constructed[0].extraTools ?? [];
    const createIssue = tools.find((tool) => tool.name === 'issues_create');
    const readIssue = tools.find((tool) => tool.name === 'issues_read');
    backend.setCurrentSessionId('first-turn');
    const result = await createIssue?.execute('create', { title: 'Runtime test' });
    const issue = JSON.parse(result?.content[0].text ?? '{}') as { id: string };
    backend.setCurrentSessionId('second-turn');
    await readIssue?.execute('read', { id_or_key: issue.id });
    expect(projectsDb.sessionLinks.listByIssue(issue.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ session_id: 'first-turn', agent_id: agent.name }),
        expect.objectContaining({ session_id: 'second-turn', agent_id: agent.name }),
      ]),
    );

    const locationTool = tools.find((tool) => tool.name === 'get_location');
    vi.spyOn(backend, 'getCurrentLocation').mockReturnValue({
      timezone: 'Asia/Singapore',
      utcOffsetMinutes: 480,
      locale: 'en-SG',
    });
    expect((await locationTool?.execute('location', {}))?.content[0].text).toContain(
      'Asia/Singapore',
    );
    vi.spyOn(backend, 'getCurrentLocation').mockReturnValue({
      timezone: 'Pacific/Auckland',
      utcOffsetMinutes: 720,
      locale: 'en-NZ',
    });
    expect((await locationTool?.execute('location-again', {}))?.content[0].text).toContain(
      'Pacific/Auckland',
    );
  });

  it('reads live parent grants, model aliases, session and skills for warmed subagent tools', async () => {
    const agent = register({ tools: ['read', 'mcp'], mcpServers: ['github'] });
    await factory()(agent.config, 'construction-conversation', agent.id);
    const input = subagentInputs[0] as SubagentExtraToolsOptions;
    expect(constructed[0].config.skills?.paths).toEqual(current.skillDirs);
    expect(constructed[0].extraSkillFiles).toEqual(current.commandFiles);
    expect(backends[0].listExtraToolNames()).toContain('agent');
    expect(input.parentTools()).toEqual(['read', 'mcp']);
    expect(input.parentMcpTools?.()).toEqual(['github__read']);
    registry.update(agent.id, {
      tools: ['bash', 'mcp'],
      mcpServers: ['linear'],
      model: 'openai/updated',
      subagents: { modelAliases: { fast: 'openai/fast' } },
    });
    backends[0].setCurrentSessionId('live-conversation');
    const listSkills = vi.spyOn(backends[0], 'listSkills').mockResolvedValue([]);
    expect(input.parentTools()).toEqual(['bash', 'mcp']);
    expect(input.parentMcpTools?.()).toEqual(['linear__read']);
    expect(input.parentModel()).toBe('openai/updated');
    expect(input.parentModelAliases?.()).toEqual({ fast: 'openai/fast' });
    expect(input.conversationId()).toBe('live-conversation');
    await input.listSkills?.();
    expect(listSkills).toHaveBeenCalledOnce();
  });

  it('uses live MCP assignments and removes a server only after its last agent unassigns', async () => {
    const agent = register({ mcpServers: ['github'] });
    const other = registry.register({ ...agent.config, name: 'other-parent' });
    const removeServer = vi.spyOn(mcpManager, 'removeServer').mockResolvedValue();
    await mcpConfigStore.addConfig({
      name: 'github',
      transport: { type: 'stdio', command: 'fixture' },
    });
    await factory()(agent.config, 'one', agent.id);
    const context = constructed[0].mcpAgentContext;
    expect(constructed[0].mcpManager).toBe(mcpManager);
    expect(constructed[0].mcpConfigStore).toBe(mcpConfigStore);
    await context?.assignToAgent('linear');
    expect(context?.getAssignedServers()).toEqual(['github', 'linear']);
    expect(await context?.unassignFromAgent('github')).toBe(false);
    expect(removeServer).not.toHaveBeenCalled();
    registry.update(other.id, { mcpServers: [] });
    await context?.assignToAgent('github');
    expect(await context?.unassignFromAgent('github')).toBe(true);
    expect(removeServer).toHaveBeenCalledWith('github');
    expect(await mcpConfigStore.loadConfigs()).toEqual([]);
    const reloaded = new AgentRegistry(join(dataDir, 'agents.json'));
    await reloaded.load();
    expect(reloaded.get(agent.id)?.config.mcpServers).toEqual(['linear']);
  });
});
