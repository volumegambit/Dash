import { EventEmitter } from 'node:events';
import { existsSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentRegistry } from '../agents/registry.js';
import type { SecretStore } from '../security/secrets.js';
import {
  type AgentSecretsFile,
  type GatewaySecretsFile,
  ProcessRuntime,
  type ProcessSpawner,
  type SpawnedProcess,
  buildGatewayConfig,
  findAvailablePort,
  validateConfigDir,
  writeSecretsFile,
} from './process.js';

describe('findAvailablePort', () => {
  it('returns a valid port number', async () => {
    const port = await findAvailablePort();
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThanOrEqual(65535);
  });

  it('returns different ports on successive calls', async () => {
    const [p1, p2] = await Promise.all([findAvailablePort(), findAvailablePort()]);
    expect(p1).not.toBe(p2);
  });
});

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

describe('writeSecretsFile', () => {
  it('writes agent secrets with 0600 permissions', async () => {
    const secrets: AgentSecretsFile = {
      anthropicApiKey: 'sk-test',
      managementToken: 'mgmt-tok',
      chatToken: 'chat-tok',
    };

    const filePath = await writeSecretsFile(secrets, 'test-agent');
    try {
      expect(existsSync(filePath)).toBe(true);

      const content = JSON.parse(await readFile(filePath, 'utf-8'));
      expect(content.anthropicApiKey).toBe('sk-test');
      expect(content.managementToken).toBe('mgmt-tok');
      expect(content.chatToken).toBe('chat-tok');

      const stats = statSync(filePath);
      expect(stats.mode & 0o777).toBe(0o600);
    } finally {
      await rm(filePath);
    }
  });

  it('writes gateway secrets with correct shape', async () => {
    const secrets: GatewaySecretsFile = {
      agents: { default: { token: 'agent-tok' } },
      channels: { telegram: { token: 'bot-tok' } },
    };

    const filePath = await writeSecretsFile(secrets, 'test-gw');
    try {
      const content = JSON.parse(await readFile(filePath, 'utf-8'));
      expect(content.agents.default.token).toBe('agent-tok');
      expect(content.channels.telegram.token).toBe('bot-tok');
    } finally {
      await rm(filePath);
    }
  });
});

describe('buildGatewayConfig', () => {
  it('generates config with MC adapter when no gateway.json', () => {
    const config = buildGatewayConfig(['default'], 9101, 9102);

    expect(config.agents).toEqual({
      default: { url: 'ws://localhost:9101/ws', token: 'PLACEHOLDER' },
    });
    expect((config.channels as Record<string, { adapter: string }>).mc.adapter).toBe(
      'mission-control',
    );
  });

  it('includes all agents in config', () => {
    const config = buildGatewayConfig(['agent-a', 'agent-b'], 9101, 9102);

    const agents = config.agents as Record<string, { url: string }>;
    expect(Object.keys(agents)).toEqual(['agent-a', 'agent-b']);
  });

  it('preserves telegram channel from gateway.json', () => {
    const config = buildGatewayConfig(['default'], 9101, 9102, {
      channels: {
        telegram: { adapter: 'telegram', agent: 'default' },
      },
    });

    const channels = config.channels as Record<string, { adapter: string }>;
    expect(channels.telegram.adapter).toBe('telegram');
    // MC adapter auto-added
    expect(channels.mc.adapter).toBe('mission-control');
  });

  it('uses allocated MC adapter port', () => {
    const config = buildGatewayConfig(['default'], 9101, 9999);

    const channels = config.channels as Record<string, { port?: number }>;
    expect(channels.mc.port).toBe(9999);
  });

  it('does not duplicate MC adapter if already in gateway.json', () => {
    const config = buildGatewayConfig(['default'], 9101, 9102, {
      channels: {
        'my-mc': { adapter: 'mission-control', agent: 'default' },
      },
    });

    const channels = config.channels as Record<string, { adapter: string }>;
    expect(channels['my-mc'].adapter).toBe('mission-control');
    expect(channels.mc).toBeUndefined();
  });
});

class FakeProcess extends EventEmitter implements SpawnedProcess {
  pid: number;
  exitCode: number | null = null;
  stdout: Readable;
  stderr: Readable;
  killed = false;

  constructor(pid: number) {
    super();
    this.pid = pid;
    this.stdout = new Readable({ read() {} });
    this.stderr = new Readable({ read() {} });
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed = true;
    if (signal !== 0) {
      this.exitCode = 0;
      this.emit('exit', 0, signal ?? 'SIGTERM');
    }
    return true;
  }
}

function createMockSpawner(): { spawner: ProcessSpawner; processes: FakeProcess[] } {
  const processes: FakeProcess[] = [];
  let nextPid = 10_000;
  return {
    processes,
    spawner: {
      spawn: () => {
        const proc = new FakeProcess(nextPid++);
        processes.push(proc);
        return proc;
      },
    },
  };
}

function createMockSecrets(): SecretStore {
  const store = new Map<string, string>();
  store.set('anthropic-api-key', 'sk-ant-test');
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
      JSON.stringify({ name: 'test-agent', model: 'claude-sonnet-4-20250514', systemPrompt: 'hi' }),
    );
    registry = new AgentRegistry(tmpDir);
    secrets = createMockSecrets();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true });
    await rm(configDir, { recursive: true });
  });

  it('deploy() registers deployment as running', async () => {
    const { spawner } = createMockSpawner();
    const runtime = new ProcessRuntime(registry, secrets, '/fake/root', spawner);

    const id = await runtime.deploy(configDir);

    const deployment = await registry.get(id);
    expect(deployment).not.toBeNull();
    expect(deployment?.status).toBe('running');
    expect(deployment?.name).toBe('test-agent');
  });

  it('deploy() records PIDs from spawned processes', async () => {
    const { spawner } = createMockSpawner();
    const runtime = new ProcessRuntime(registry, secrets, '/fake/root', spawner);

    const id = await runtime.deploy(configDir);

    const deployment = await registry.get(id);
    expect(deployment?.agentServerPid).toBe(10_000);
    expect(deployment?.gatewayPid).toBe(10_001);
  });

  it('exit handler updates registry to stopped when both processes exit', async () => {
    const { spawner, processes } = createMockSpawner();
    const runtime = new ProcessRuntime(registry, secrets, '/fake/root', spawner);

    const id = await runtime.deploy(configDir);

    const [agentServer, gateway] = processes;
    agentServer.exitCode = 0;
    agentServer.emit('exit', 0, null);
    gateway.exitCode = 0;
    gateway.emit('exit', 0, null);

    // Wait for async registry update
    await new Promise((r) => setTimeout(r, 50));

    const deployment = await registry.get(id);
    expect(deployment?.status).toBe('stopped');
  });

  it('exit handler does not update registry when only agent exits', async () => {
    const { spawner, processes } = createMockSpawner();
    const runtime = new ProcessRuntime(registry, secrets, '/fake/root', spawner);

    const id = await runtime.deploy(configDir);

    const [agentServer] = processes;
    agentServer.exitCode = 1;
    agentServer.emit('exit', 1, null);

    await new Promise((r) => setTimeout(r, 50));

    const deployment = await registry.get(id);
    expect(deployment?.status).toBe('running');
  });

  it('stop() kills processes and updates registry', async () => {
    const { spawner, processes } = createMockSpawner();
    const runtime = new ProcessRuntime(registry, secrets, '/fake/root', spawner);

    const id = await runtime.deploy(configDir);
    await runtime.stop(id);

    const [agentServer, gateway] = processes;
    expect(agentServer.killed).toBe(true);
    expect(gateway.killed).toBe(true);

    const deployment = await registry.get(id);
    expect(deployment?.status).toBe('stopped');
  });

  it('getStatus() returns running for live deployment', async () => {
    const { spawner } = createMockSpawner();
    const runtime = new ProcessRuntime(registry, secrets, '/fake/root', spawner);

    const id = await runtime.deploy(configDir);
    const status = await runtime.getStatus(id);

    expect(status.state).toBe('running');
    expect(status.agentServerPid).toBe(10_000);
    expect(status.gatewayPid).toBe(10_001);
    expect(status.uptime).toBeGreaterThanOrEqual(0);
  });

  it('getStatus() returns stopped after processes exit', async () => {
    const { spawner, processes } = createMockSpawner();
    const runtime = new ProcessRuntime(registry, secrets, '/fake/root', spawner);

    const id = await runtime.deploy(configDir);

    const [agentServer, gateway] = processes;
    agentServer.exitCode = 0;
    agentServer.emit('exit', 0, null);
    gateway.exitCode = 0;
    gateway.emit('exit', 0, null);

    await new Promise((r) => setTimeout(r, 50));

    const status = await runtime.getStatus(id);
    expect(status.state).toBe('stopped');
  });

  it('remove() stops, cleans secrets, and removes from registry', async () => {
    const { spawner } = createMockSpawner();
    const runtime = new ProcessRuntime(registry, secrets, '/fake/root', spawner);

    const id = await runtime.deploy(configDir);
    await runtime.remove(id);

    const deployment = await registry.get(id);
    expect(deployment).toBeNull();

    expect(await secrets.get(`agent-token:${id}`)).toBeNull();
    expect(await secrets.get(`chat-token:${id}`)).toBeNull();
  });
});
