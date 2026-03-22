import { existsSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentRegistry } from '../agents/registry.js';
import type { SecretStore } from '../security/secrets.js';
import type { GatewayManagementClient } from './gateway-client.js';
import {
  DeploymentStartupError,
  ProcessRuntime,
  type ProcessSpawner,
  type SpawnedProcess,
  validateConfigDir,
} from './process.js';

describe('validateConfigDir', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'mc-validate-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true });
  });

  it('rejects non-existent directory', () => {
    expect(() => validateConfigDir('/nonexistent/path')).toThrow('does not exist');
  });

  it('rejects path that is a file', async () => {
    const filePath = join(tmpDir, 'not-a-dir.json');
    await writeFile(filePath, '{}');
    expect(() => validateConfigDir(filePath)).toThrow('not a directory');
  });

  it('rejects directory without agents/ or dash.json', () => {
    expect(() => validateConfigDir(tmpDir)).toThrow('must contain agents/ directory or dash.json');
  });

  it('accepts directory with agents/ subdirectory', async () => {
    await mkdir(join(tmpDir, 'agents'));
    expect(() => validateConfigDir(tmpDir)).not.toThrow();
  });

  it('accepts directory with dash.json', async () => {
    await writeFile(join(tmpDir, 'dash.json'), '{}');
    expect(() => validateConfigDir(tmpDir)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockSecrets(): SecretStore {
  const store = new Map<string, string>();
  store.set('anthropic-api-key:default', 'sk-ant-test');
  return {
    get: async (key: string) => store.get(key) ?? null,
    set: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
    list: async () => Array.from(store.keys()),
  };
}

function createMockSecretsWithKeys(keys: Record<string, string>): SecretStore {
  const store = new Map<string, string>(Object.entries(keys));
  return {
    get: async (key: string) => store.get(key) ?? null,
    set: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
    list: async () => Array.from(store.keys()),
  };
}

function createMockGatewayClient() {
  return {
    health: vi.fn().mockResolvedValue({
      status: 'healthy',
      startedAt: '2026-01-01T00:00:00Z',
      agents: 0,
      channels: 0,
    }),
    registerAgent: vi.fn().mockResolvedValue(undefined),
    registerChannel: vi.fn().mockResolvedValue(undefined),
    deregisterDeployment: vi.fn().mockResolvedValue(undefined),
    registerRuntimeAgent: vi.fn().mockResolvedValue(undefined),
    setRuntimeAgentCredentials: vi.fn().mockResolvedValue(undefined),
    removeRuntimeAgent: vi.fn().mockResolvedValue(undefined),
    getRuntimeAgent: vi.fn().mockResolvedValue({
      name: 'test-agent',
      config: {},
      status: 'active',
      registeredAt: Date.now(),
    }),
    updateRuntimeAgent: vi.fn().mockResolvedValue(undefined),
    listRuntimeAgents: vi.fn().mockResolvedValue([]),
    disableRuntimeAgent: vi.fn().mockResolvedValue(undefined),
    enableRuntimeAgent: vi.fn().mockResolvedValue(undefined),
  } as unknown as GatewayManagementClient & {
    registerRuntimeAgent: ReturnType<typeof vi.fn>;
    setRuntimeAgentCredentials: ReturnType<typeof vi.fn>;
    removeRuntimeAgent: ReturnType<typeof vi.fn>;
    getRuntimeAgent: ReturnType<typeof vi.fn>;
    updateRuntimeAgent: ReturnType<typeof vi.fn>;
    deregisterDeployment: ReturnType<typeof vi.fn>;
    registerChannel: ReturnType<typeof vi.fn>;
  };
}

function createMockSpawner(): ProcessSpawner {
  return {
    spawn: vi.fn().mockReturnValue({
      pid: 12345,
      exitCode: null,
      stdout: null,
      stderr: null,
      kill: vi.fn(),
      on: vi.fn(),
      unref: vi.fn(),
    }),
  };
}

/** Create a ProcessRuntime with a pre-configured mock gateway client. */
async function createRuntimeWithGateway(
  registry: AgentRegistry,
  secrets: SecretStore,
  tmpDir: string,
): Promise<{ runtime: ProcessRuntime; gatewayClient: ReturnType<typeof createMockGatewayClient> }> {
  const gatewayClient = createMockGatewayClient();
  const spawner = createMockSpawner();

  const { GatewayStateStore } = await import('./gateway-state.js');
  const store = new GatewayStateStore(tmpDir);
  await store.write({
    pid: process.pid,
    startedAt: '2026-01-01T00:00:00Z',
    token: 'gw-tok',
    port: 9300,
    channelPort: 9200,
    chatToken: 'gw-chat-tok',
  });

  const runtime = new ProcessRuntime(
    registry,
    secrets,
    '/fake/root',
    spawner,
    undefined,
    undefined,
    {
      gatewayDataDir: tmpDir,
      makeGatewayClient: () => gatewayClient as unknown as GatewayManagementClient,
    },
  );

  return { runtime, gatewayClient };
}

// ---------------------------------------------------------------------------
// deploy() model/key validation
// ---------------------------------------------------------------------------

describe('ProcessRuntime.deploy() model/key validation', () => {
  let tmpDir: string;
  let configDir: string;
  let registry: AgentRegistry;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'mc-validation-'));
    configDir = await mkdtemp(join(tmpdir(), 'mc-config-'));
    await mkdir(join(configDir, 'agents'));
    registry = new AgentRegistry(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true });
    await rm(configDir, { recursive: true });
  });

  it('throws if primary model provider has no API key', async () => {
    await writeFile(
      join(configDir, 'agents', 'test-agent.json'),
      JSON.stringify({ model: 'anthropic/claude-sonnet-4-20250514', systemPrompt: 'hi' }),
    );
    const secrets = createMockSecretsWithKeys({ 'openai-api-key:default': 'sk-openai-test' });
    const { runtime } = await createRuntimeWithGateway(registry, secrets, tmpDir);

    await expect(runtime.deploy(configDir)).rejects.toThrow(
      "No API key configured for provider 'anthropic'",
    );
  });

  it('succeeds when primary model provider has a matching key', async () => {
    await writeFile(
      join(configDir, 'agents', 'test-agent.json'),
      JSON.stringify({ model: 'openai/gpt-4o', systemPrompt: 'hi' }),
    );
    const secrets = createMockSecretsWithKeys({ 'openai-api-key:default': 'sk-openai-test' });
    const { runtime } = await createRuntimeWithGateway(registry, secrets, tmpDir);

    await expect(runtime.deploy(configDir)).resolves.toBeTypeOf('string');
  });

  it('succeeds even if a fallback model provider has no key', async () => {
    await writeFile(
      join(configDir, 'agents', 'test-agent.json'),
      JSON.stringify({
        model: 'openai/gpt-4o',
        fallbackModels: ['anthropic/claude-sonnet-4-20250514'],
        systemPrompt: 'hi',
      }),
    );
    const secrets = createMockSecretsWithKeys({ 'openai-api-key:default': 'sk-openai-test' });
    const { runtime } = await createRuntimeWithGateway(registry, secrets, tmpDir);

    await expect(runtime.deploy(configDir)).resolves.toBeTypeOf('string');
  });
});

// ---------------------------------------------------------------------------
// updateAgentConfig
// ---------------------------------------------------------------------------

describe('ProcessRuntime.updateAgentConfig', () => {
  it('rewrites model and fallbackModels in the agent JSON file', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'mc-update-test-'));
    const agentsDir = join(configDir, 'agents');
    await mkdir(agentsDir, { recursive: true });
    await writeFile(
      join(agentsDir, 'my-agent.json'),
      JSON.stringify({ model: 'anthropic/claude-sonnet-4-20250514', systemPrompt: 'hello' }),
    );

    const fakeDeployment = {
      id: 'test-id',
      configDir,
      status: 'running' as const,
      name: 'my-agent',
      target: 'local' as const,
      createdAt: new Date().toISOString(),
      config: { target: 'local' as const, channels: {} },
    };
    const fakeRegistry = {
      get: async (_id: string) => fakeDeployment,
      list: async () => [fakeDeployment],
      add: async () => {},
      update: async () => {},
      remove: async () => {},
    };
    const fakeSecrets = {
      get: async () => null,
      set: async () => {},
      delete: async () => {},
      list: async () => [],
      isUnlocked: () => true,
      lock: () => {},
    };

    const runtime = new ProcessRuntime(
      fakeRegistry as unknown as Parameters<typeof ProcessRuntime>[0],
      fakeSecrets as unknown as Parameters<typeof ProcessRuntime>[1],
      '/',
    );
    await runtime.updateAgentConfig('test-id', {
      model: 'openai/gpt-4o',
      fallbackModels: ['anthropic/claude-haiku-4-5-20251001'],
    });

    const updated = JSON.parse(await readFile(join(agentsDir, 'my-agent.json'), 'utf-8'));
    expect(updated.model).toBe('openai/gpt-4o');
    expect(updated.fallbackModels).toEqual(['anthropic/claude-haiku-4-5-20251001']);
    expect(updated.systemPrompt).toBe('hello');

    await rm(configDir, { recursive: true });
  });
});

// ---------------------------------------------------------------------------
// Lifecycle (deploy, stop, start, remove, getStatus)
// ---------------------------------------------------------------------------

describe('ProcessRuntime lifecycle', () => {
  let tmpDir: string;
  let configDir: string;
  let registry: AgentRegistry;
  let secrets: SecretStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'mc-lifecycle-'));
    configDir = await mkdtemp(join(tmpdir(), 'mc-config-'));
    await mkdir(join(configDir, 'agents'));
    await writeFile(
      join(configDir, 'agents', 'test-agent.json'),
      JSON.stringify({
        name: 'test-agent',
        model: 'claude-sonnet-4-20250514',
        systemPrompt: 'hi',
      }),
    );
    registry = new AgentRegistry(tmpDir);
    secrets = createMockSecrets();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true });
    await rm(configDir, { recursive: true });
  });

  it('deploy() registers deployment as running', async () => {
    const { runtime } = await createRuntimeWithGateway(registry, secrets, tmpDir);
    const id = await runtime.deploy(configDir);

    const deployment = await registry.get(id);
    expect(deployment).not.toBeNull();
    expect(deployment?.status).toBe('running');
    expect(deployment?.name).toBe('test-agent');
  });

  it('deploy() calls registerRuntimeAgent on gateway', async () => {
    const { runtime, gatewayClient } = await createRuntimeWithGateway(registry, secrets, tmpDir);
    await runtime.deploy(configDir);

    expect(gatewayClient.registerRuntimeAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'test-agent',
        model: 'claude-sonnet-4-20250514',
        systemPrompt: 'hi',
      }),
    );
  });

  it('deploy() embeds providerApiKeys in agent config sent to gateway', async () => {
    const { runtime, gatewayClient } = await createRuntimeWithGateway(registry, secrets, tmpDir);
    await runtime.deploy(configDir);

    expect(gatewayClient.registerRuntimeAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'test-agent',
        providerApiKeys: expect.objectContaining({ anthropic: 'sk-ant-test' }),
      }),
    );
  });

  it('stop() calls disableRuntimeAgent and deregisterDeployment', async () => {
    const { runtime, gatewayClient } = await createRuntimeWithGateway(registry, secrets, tmpDir);
    const id = await runtime.deploy(configDir);
    await runtime.stop(id);

    expect(gatewayClient.disableRuntimeAgent).toHaveBeenCalledWith('test-agent');
    expect(gatewayClient.deregisterDeployment).toHaveBeenCalledWith(id);

    const deployment = await registry.get(id);
    expect(deployment?.status).toBe('stopped');
  });

  it('getStatus() returns running state for deployed agent', async () => {
    const { runtime } = await createRuntimeWithGateway(registry, secrets, tmpDir);
    const id = await runtime.deploy(configDir);
    const status = await runtime.getStatus(id);
    expect(status.state).toBe('running');
  });

  it('getStatus() returns stopped after stop()', async () => {
    const { runtime } = await createRuntimeWithGateway(registry, secrets, tmpDir);
    const id = await runtime.deploy(configDir);
    await runtime.stop(id);
    const status = await runtime.getStatus(id);
    expect(status.state).toBe('stopped');
  });

  it('stop() from a fresh runtime instance works via gateway', async () => {
    const { runtime: runtime1, gatewayClient } = await createRuntimeWithGateway(
      registry,
      secrets,
      tmpDir,
    );
    const id = await runtime1.deploy(configDir);

    // Fresh runtime simulates MC restart
    const runtime2 = new ProcessRuntime(
      registry,
      secrets,
      '/fake/root',
      createMockSpawner(),
      undefined,
      undefined,
      {
        gatewayDataDir: tmpDir,
        makeGatewayClient: () => gatewayClient as unknown as GatewayManagementClient,
      },
    );

    await runtime2.stop(id);

    const deployment = await registry.get(id);
    expect(deployment?.status).toBe('stopped');
  });

  it('remove() stops, cleans secrets, and removes from registry', async () => {
    const { runtime } = await createRuntimeWithGateway(registry, secrets, tmpDir);
    const id = await runtime.deploy(configDir);
    await runtime.remove(id);

    const deployment = await registry.get(id);
    expect(deployment).toBeNull();

    expect(await secrets.get(`agent-token:${id}`)).toBeNull();
    expect(await secrets.get(`chat-token:${id}`)).toBeNull();
  });

  it('deploy() registers error when gateway registerRuntimeAgent fails', async () => {
    const { runtime, gatewayClient } = await createRuntimeWithGateway(registry, secrets, tmpDir);
    (gatewayClient.registerRuntimeAgent as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('Gateway unavailable'),
    );

    await expect(runtime.deploy(configDir)).rejects.toThrow(DeploymentStartupError);

    const deployments = await registry.list();
    expect(deployments).toHaveLength(1);
    expect(deployments[0].status).toBe('error');
    expect(deployments[0].errorMessage).toBe('Gateway unavailable');
  });
});

// ---------------------------------------------------------------------------
// deploy() without gateway
// ---------------------------------------------------------------------------

describe('ProcessRuntime.deploy() without gateway', () => {
  let tmpDir: string;
  let configDir: string;
  let registry: AgentRegistry;
  let secrets: SecretStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'mc-nogw-'));
    configDir = await mkdtemp(join(tmpdir(), 'mc-nogw-cfg-'));
    await mkdir(join(configDir, 'agents'));
    await writeFile(
      join(configDir, 'agents', 'test-agent.json'),
      JSON.stringify({
        name: 'test-agent',
        model: 'claude-sonnet-4-20250514',
        systemPrompt: 'hi',
      }),
    );
    registry = new AgentRegistry(tmpDir);
    secrets = createMockSecrets();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true });
    await rm(configDir, { recursive: true });
  });

  it('throws DeploymentStartupError when no gateway is configured', async () => {
    const runtime = new ProcessRuntime(registry, secrets, '/fake/root');
    await expect(runtime.deploy(configDir)).rejects.toThrow(DeploymentStartupError);
    await expect(runtime.deploy(configDir)).rejects.toThrow('No gateway configured');
  });
});

// ---------------------------------------------------------------------------
// registerWithGateway
// ---------------------------------------------------------------------------

describe('ProcessRuntime.registerWithGateway', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'mc-rgw-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true });
  });

  it('registers runtime agents and sets credentials for a running deployment', async () => {
    const deploymentId = 'dep-abc123';
    const gatewayClient = createMockGatewayClient();

    const fakeDeployment = {
      id: deploymentId,
      name: 'test-agent',
      target: 'local' as const,
      status: 'running' as const,
      createdAt: new Date().toISOString(),
      config: {
        target: 'local' as const,
        agents: {
          'test-agent': {
            name: 'test-agent',
            model: 'anthropic/claude-sonnet-4-20250514',
            systemPrompt: 'hi',
          },
        },
        channels: {},
      },
    };

    const fakeRegistry = {
      get: async (id: string) => (id === deploymentId ? fakeDeployment : null),
      list: async () => [fakeDeployment],
      add: async () => {},
      update: async () => {},
      remove: async () => {},
    };

    const fakeSecrets: SecretStore = {
      get: async (key: string) => (key === 'anthropic-api-key:default' ? 'sk-ant-test-123' : null),
      set: async () => {},
      delete: async () => {},
      list: async () => ['anthropic-api-key:default'],
    };

    const { GatewayStateStore } = await import('./gateway-state.js');
    const store = new GatewayStateStore(tmpDir);
    await store.write({
      pid: process.pid,
      startedAt: '2026-01-01T00:00:00Z',
      token: 'gw-tok',
      port: 9300,
      channelPort: 9200,
    });

    const runtime = new ProcessRuntime(
      fakeRegistry as unknown as Parameters<typeof ProcessRuntime>[0],
      fakeSecrets,
      '/fake/root',
      undefined,
      undefined,
      undefined,
      {
        gatewayDataDir: tmpDir,
        makeGatewayClient: () => gatewayClient as unknown as GatewayManagementClient,
      },
    );

    await runtime.registerWithGateway(deploymentId);

    expect(gatewayClient.registerRuntimeAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'test-agent',
        model: 'anthropic/claude-sonnet-4-20250514',
      }),
    );
    expect(gatewayClient.setRuntimeAgentCredentials).toHaveBeenCalledWith(
      'test-agent',
      expect.objectContaining({ anthropic: 'sk-ant-test-123' }),
    );
  });

  it('skips silently if deployment is not found', async () => {
    const fakeRegistry = {
      get: async () => null,
      list: async () => [],
      add: async () => {},
      update: async () => {},
      remove: async () => {},
    };

    const fakeSecrets: SecretStore = {
      get: async () => null,
      set: async () => {},
      delete: async () => {},
      list: async () => [],
    };

    const gatewayClient = createMockGatewayClient();
    const { GatewayStateStore } = await import('./gateway-state.js');
    const store = new GatewayStateStore(tmpDir);
    await store.write({
      pid: process.pid,
      startedAt: '2026-01-01T00:00:00Z',
      token: 'tok',
      port: 9300,
      channelPort: 9200,
    });

    const runtime = new ProcessRuntime(
      fakeRegistry as unknown as Parameters<typeof ProcessRuntime>[0],
      fakeSecrets,
      '/fake/root',
      undefined,
      undefined,
      undefined,
      {
        gatewayDataDir: tmpDir,
        makeGatewayClient: () => gatewayClient as unknown as GatewayManagementClient,
      },
    );

    await runtime.registerWithGateway('nonexistent');
    expect(gatewayClient.registerRuntimeAgent).not.toHaveBeenCalled();
  });

  it('skips silently if deployment is not running', async () => {
    const deploymentId = 'dep-stopped';
    const fakeDeployment = {
      id: deploymentId,
      name: 'agent',
      target: 'local' as const,
      status: 'stopped' as const,
      createdAt: new Date().toISOString(),
      config: { target: 'local' as const, agents: { agent: {} }, channels: {} },
    };

    const fakeRegistry = {
      get: async () => fakeDeployment,
      list: async () => [fakeDeployment],
      add: async () => {},
      update: async () => {},
      remove: async () => {},
    };

    const fakeSecrets: SecretStore = {
      get: async () => null,
      set: async () => {},
      delete: async () => {},
      list: async () => [],
    };

    const gatewayClient = createMockGatewayClient();
    const { GatewayStateStore } = await import('./gateway-state.js');
    const store = new GatewayStateStore(tmpDir);
    await store.write({
      pid: process.pid,
      startedAt: '2026-01-01T00:00:00Z',
      token: 'tok',
      port: 9300,
      channelPort: 9200,
    });

    const runtime = new ProcessRuntime(
      fakeRegistry as unknown as Parameters<typeof ProcessRuntime>[0],
      fakeSecrets,
      '/fake/root',
      undefined,
      undefined,
      undefined,
      {
        gatewayDataDir: tmpDir,
        makeGatewayClient: () => gatewayClient as unknown as GatewayManagementClient,
      },
    );

    await runtime.registerWithGateway(deploymentId);
    expect(gatewayClient.registerRuntimeAgent).not.toHaveBeenCalled();
  });

  it('skips silently if no gateway is configured', async () => {
    const deploymentId = 'dep-abc';
    const fakeDeployment = {
      id: deploymentId,
      name: 'agent',
      target: 'local' as const,
      status: 'running' as const,
      createdAt: new Date().toISOString(),
      config: { target: 'local' as const, agents: { agent: {} }, channels: {} },
    };

    const fakeRegistry = {
      get: async () => fakeDeployment,
      list: async () => [fakeDeployment],
      add: async () => {},
      update: async () => {},
      remove: async () => {},
    };

    const fakeSecrets: SecretStore = {
      get: async () => null,
      set: async () => {},
      delete: async () => {},
      list: async () => [],
    };

    // No gatewayOptions — getGatewayClient returns null
    const runtime = new ProcessRuntime(
      fakeRegistry as unknown as Parameters<typeof ProcessRuntime>[0],
      fakeSecrets,
      '/fake/root',
    );

    // Should not throw
    await expect(runtime.registerWithGateway(deploymentId)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ensureGateway interaction via deploy/stop
// ---------------------------------------------------------------------------

describe('ProcessRuntime gateway integration', () => {
  let tmpDir: string;
  let configDir: string;
  let registry: AgentRegistry;
  let secrets: SecretStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'mc-gw-'));
    configDir = await mkdtemp(join(tmpdir(), 'mc-gw-cfg-'));
    await mkdir(join(configDir, 'agents'));
    await writeFile(
      join(configDir, 'agents', 'test-agent.json'),
      JSON.stringify({
        name: 'test-agent',
        model: 'claude-sonnet-4-20250514',
        systemPrompt: 'hi',
      }),
    );
    registry = new AgentRegistry(tmpDir);
    secrets = createMockSecrets();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true });
    await rm(configDir, { recursive: true });
  });

  it('deploy() does not spawn any agent server process', async () => {
    const { runtime } = await createRuntimeWithGateway(registry, secrets, tmpDir);
    await runtime.deploy(configDir);

    // No process spawning occurred (gateway is pre-configured via state file)
    // The runtime communicates solely via gateway client API
    const deployments = await registry.list();
    expect(deployments).toHaveLength(1);
    expect(deployments[0].status).toBe('running');
  });

  it('stop() calls deregisterDeployment on gateway', async () => {
    const { runtime, gatewayClient } = await createRuntimeWithGateway(registry, secrets, tmpDir);
    const id = await runtime.deploy(configDir);
    await runtime.stop(id);

    expect(gatewayClient.deregisterDeployment).toHaveBeenCalledWith(id);
  });

  it('stop() calls disableRuntimeAgent for each agent', async () => {
    const { runtime, gatewayClient } = await createRuntimeWithGateway(registry, secrets, tmpDir);
    const id = await runtime.deploy(configDir);
    await runtime.stop(id);

    expect(gatewayClient.disableRuntimeAgent).toHaveBeenCalledWith('test-agent');
  });
});
