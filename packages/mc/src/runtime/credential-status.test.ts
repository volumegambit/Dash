import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRegistry } from '../agents/registry.js';
import { FileSecretStore } from '../security/secrets.js';
import { providerSecretKey } from './provider-keys.js';
import { ProcessRuntime, type GatewayOptions, type ProcessSpawner } from './process.js';

const noopSpawner: ProcessSpawner = {
  spawn: () => {
    throw new Error('should not spawn');
  },
};

describe('credential status on deploy', () => {
  let tmpDir: string;
  let registry: AgentRegistry;
  let secrets: FileSecretStore;
  let configDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'cred-status-'));
    registry = new AgentRegistry(join(tmpDir, 'data'));
    secrets = new FileSecretStore(join(tmpDir, 'secrets'));
    configDir = join(tmpDir, 'config');
    await mkdir(join(configDir, 'agents'), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('sets credentialStatus missing when no provider keys exist', async () => {
    // Agent config that references anthropic model
    await writeFile(
      join(configDir, 'agents', 'test-agent.json'),
      JSON.stringify({
        name: 'test-agent',
        model: 'anthropic/claude-sonnet',
        systemPrompt: 'You are a test agent.',
      }),
    );

    const runtime = new ProcessRuntime(registry, secrets, tmpDir, noopSpawner);

    await expect(runtime.deploy(configDir)).rejects.toThrow(/No provider API key configured/);

    // Check that the deployment was registered with credentialStatus: 'missing'
    const deployments = await registry.list();
    expect(deployments).toHaveLength(1);
    expect(deployments[0].credentialStatus).toBe('missing');
    expect(deployments[0].status).toBe('error');
    expect(deployments[0].errorMessage).toMatch(/No provider API key configured/);
  });

  it('sets credentialStatus missing when agent references nonexistent credential key name', async () => {
    // Set up a provider key with name "default"
    await secrets.set(providerSecretKey('anthropic', 'default'), 'sk-ant-xxx');

    // Agent config that references a specific key name that doesn't exist
    await writeFile(
      join(configDir, 'agents', 'test-agent.json'),
      JSON.stringify({
        name: 'test-agent',
        model: 'anthropic/claude-sonnet',
        systemPrompt: 'You are a test agent.',
        credentialKeys: { anthropic: 'production-key' },
      }),
    );

    const runtime = new ProcessRuntime(registry, secrets, tmpDir, noopSpawner);

    await expect(runtime.deploy(configDir)).rejects.toThrow(
      /requires credential "production-key"/,
    );

    // Check that the deployment was registered with credentialStatus: 'missing'
    const deployments = await registry.list();
    expect(deployments).toHaveLength(1);
    expect(deployments[0].credentialStatus).toBe('missing');
    expect(deployments[0].credentialProvider).toBe('anthropic');
    expect(deployments[0].credentialDetail).toBe('production-key');
    expect(deployments[0].status).toBe('error');
  });

  it('sets credentialStatus missing when provider has no API key', async () => {
    // Set up a key for a different provider
    await secrets.set(providerSecretKey('openai', 'default'), 'sk-openai-xxx');

    // Agent config referencing anthropic
    await writeFile(
      join(configDir, 'agents', 'test-agent.json'),
      JSON.stringify({
        name: 'test-agent',
        model: 'anthropic/claude-sonnet',
        systemPrompt: 'You are a test agent.',
      }),
    );

    const runtime = new ProcessRuntime(registry, secrets, tmpDir, noopSpawner);

    await expect(runtime.deploy(configDir)).rejects.toThrow(
      /No API key configured for provider 'anthropic'/,
    );

    const deployments = await registry.list();
    expect(deployments).toHaveLength(1);
    expect(deployments[0].credentialStatus).toBe('missing');
    expect(deployments[0].credentialProvider).toBe('anthropic');
    expect(deployments[0].status).toBe('error');
  });

  it('sets credentialStatus ok on successful deploy', async () => {
    // Set up provider key
    await secrets.set(providerSecretKey('anthropic', 'default'), 'sk-ant-xxx');

    await writeFile(
      join(configDir, 'agents', 'test-agent.json'),
      JSON.stringify({
        name: 'test-agent',
        model: 'anthropic/claude-sonnet',
        systemPrompt: 'You are a test agent.',
      }),
    );

    // We need a gateway for successful deploy — use gateway options with a fake client
    const fakeGatewayClient = {
      health: async () => ({ startedAt: '2024-01-01T00:00:00Z', version: '1.0.0' }),
      registerRuntimeAgent: async () => {},
      setRuntimeAgentCredentials: async () => {},
      registerChannel: async () => {},
      deregisterDeployment: async () => {},
      enableRuntimeAgent: async () => {},
      disableRuntimeAgent: async () => {},
      getRuntimeAgent: async () => ({ status: 'active' }),
      updateRuntimeAgent: async () => {},
    };

    const gatewayOpts: GatewayOptions = {
      gatewayDataDir: join(tmpDir, 'gateway'),
      makeGatewayClient: () => fakeGatewayClient as any,
    };

    // We need ensureGateway to return the fake client, so we need the gateway state file
    // Instead, let's mock by subclassing
    const runtime = new (class extends ProcessRuntime {
      override async ensureGateway() {
        return fakeGatewayClient as any;
      }
    })(registry, secrets, tmpDir, noopSpawner, undefined, undefined, gatewayOpts);

    const id = await runtime.deploy(configDir);

    const deployment = await registry.get(id);
    expect(deployment).not.toBeNull();
    expect(deployment!.credentialStatus).toBe('ok');
    expect(deployment!.status).toBe('running');
  });
});
