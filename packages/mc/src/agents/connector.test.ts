import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SecretStore } from '../security/secrets.js';
import type { AgentDeployment } from '../types.js';
import { AgentConnector } from './connector.js';
import { AgentRegistry } from './registry.js';

const baseConfig: AgentDeployment['config'] = {
  target: 'local',
  agents: {
    default: {
      name: 'default',
      model: 'claude-sonnet-4-20250514',
      systemPrompt: 'Test agent',
    },
  },
  channels: {},
};

function createFakeSecrets(data: Record<string, string> = {}): SecretStore {
  return {
    get: async (key: string) => data[key] ?? null,
    set: async (key: string, value: string) => {
      data[key] = value;
    },
    delete: async (key: string) => {
      delete data[key];
    },
    list: async () => Object.keys(data),
  };
}

describe('AgentConnector', () => {
  let tempDir: string;
  let registry: AgentRegistry;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'mc-connector-'));
    registry = new AgentRegistry(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  it('throws for non-existent deployment', async () => {
    const connector = new AgentConnector(registry, createFakeSecrets());
    await expect(connector.getClient('missing')).rejects.toThrow('not found');
  });

  it('uses managementToken from deployment record', async () => {
    await registry.add({
      id: 'local-1',
      name: 'test',
      target: 'local',
      status: 'running',
      config: baseConfig,
      createdAt: '2026-03-01T00:00:00Z',
      managementPort: 9200,
      managementToken: 'inline-token',
    });

    const connector = new AgentConnector(registry, createFakeSecrets());
    const client = await connector.getClient('local-1');
    // Verify the client was created (it's a ManagementClient instance)
    expect(client).toBeDefined();
    expect(client.health).toBeTypeOf('function');
  });

  it('falls back to secrets store when no managementToken', async () => {
    await registry.add({
      id: 'local-2',
      name: 'test',
      target: 'local',
      status: 'running',
      config: baseConfig,
      createdAt: '2026-03-01T00:00:00Z',
      managementPort: 9200,
    });

    const secrets = createFakeSecrets({ 'agent-token:local-2': 'secret-token' });
    const connector = new AgentConnector(registry, secrets);
    const client = await connector.getClient('local-2');
    expect(client).toBeDefined();
  });

  it('throws when no token available anywhere', async () => {
    await registry.add({
      id: 'local-3',
      name: 'test',
      target: 'local',
      status: 'running',
      config: baseConfig,
      createdAt: '2026-03-01T00:00:00Z',
    });

    const connector = new AgentConnector(registry, createFakeSecrets());
    await expect(connector.getClient('local-3')).rejects.toThrow('No management token');
  });

  it('uses default port 9100 for local deployments without port', async () => {
    await registry.add({
      id: 'local-4',
      name: 'test',
      target: 'local',
      status: 'running',
      config: baseConfig,
      createdAt: '2026-03-01T00:00:00Z',
      managementToken: 'tok',
    });

    const connector = new AgentConnector(registry, createFakeSecrets());
    const client = await connector.getClient('local-4');
    expect(client).toBeDefined();
  });

  it('throws for cloud deployment without IP', async () => {
    await registry.add({
      id: 'cloud-1',
      name: 'test',
      target: 'digitalocean',
      status: 'running',
      config: { ...baseConfig, target: 'digitalocean' },
      createdAt: '2026-03-01T00:00:00Z',
      managementToken: 'tok',
    });

    const connector = new AgentConnector(registry, createFakeSecrets());
    await expect(connector.getClient('cloud-1')).rejects.toThrow('No IP address');
  });

  it('creates client for cloud deployment with IP', async () => {
    await registry.add({
      id: 'cloud-2',
      name: 'test',
      target: 'digitalocean',
      status: 'running',
      config: { ...baseConfig, target: 'digitalocean' },
      createdAt: '2026-03-01T00:00:00Z',
      managementToken: 'tok',
      dropletIp: '10.0.0.1',
      managementPort: 9300,
    });

    const connector = new AgentConnector(registry, createFakeSecrets());
    const client = await connector.getClient('cloud-2');
    expect(client).toBeDefined();
  });
});
