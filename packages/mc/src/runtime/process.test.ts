import { EventEmitter } from 'node:events';
import { existsSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentRegistry } from '../agents/registry.js';
import type { SecretStore } from '../security/secrets.js';
import type { MessagingApp } from '../types.js';
import type { GatewayManagementClient } from './gateway-client.js';
import {
  type AgentSecretsFile,
  DeploymentStartupError,
  ProcessRuntime,
  type ProcessSpawner,
  type SpawnedProcess,
  type StartupWatcher,
  findAvailablePort,
  validateConfigDir,
  waitForStartup,
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
      providerApiKeys: { anthropic: 'sk-test' },
      managementToken: 'mgmt-tok',
      chatToken: 'chat-tok',
    };

    const filePath = await writeSecretsFile(secrets, 'test-agent');
    try {
      expect(existsSync(filePath)).toBe(true);

      const content = JSON.parse(await readFile(filePath, 'utf-8'));
      expect(content.providerApiKeys?.anthropic).toBe('sk-test');
      expect(content.managementToken).toBe('mgmt-tok');
      expect(content.chatToken).toBe('chat-tok');

      const stats = statSync(filePath);
      expect(stats.mode & 0o777).toBe(0o600);
    } finally {
      await rm(filePath);
    }
  });
});

class FakeProcess extends EventEmitter implements SpawnedProcess {
  pid: number;
  exitCode: number | null = null;
  killed = false;
  stdout: PassThrough;
  stderr: PassThrough;

  constructor(pid: number) {
    super();
    this.pid = pid;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    if (signal !== 0) {
      this.killed = true;
      this.exitCode = 0;
      this.stdout.end();
      this.stderr.end();
      this.emit('exit', 0, signal ?? 'SIGTERM');
    }
    return true;
  }

  unref(): void {}

  simulateLog(line: string): void {
    this.stdout.write(`${line}\n`);
  }

  simulateExit(code: number): void {
    this.exitCode = code;
    this.stdout.end();
    this.stderr.end();
    this.emit('exit', code, null);
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

    const successWatcher: StartupWatcher = async () => ({ success: true });
    const runtime = new ProcessRuntime(
      fakeRegistry as any,
      fakeSecrets as any,
      '/',
      undefined,
      undefined,
      successWatcher,
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
    const successWatcher: StartupWatcher = async () => ({ success: true });
    const runtime = new ProcessRuntime(
      registry,
      secrets,
      '/fake/root',
      spawner,
      undefined,
      successWatcher,
    );

    const id = await runtime.deploy(configDir);

    const deployment = await registry.get(id);
    expect(deployment).not.toBeNull();
    expect(deployment?.status).toBe('running');
    expect(deployment?.name).toBe('test-agent');
  });

  it('deploy() records agentServerPid from spawned process', async () => {
    const { spawner } = createMockSpawner();
    const successWatcher: StartupWatcher = async () => ({ success: true });
    const runtime = new ProcessRuntime(
      registry,
      secrets,
      '/fake/root',
      spawner,
      undefined,
      successWatcher,
    );

    const id = await runtime.deploy(configDir);

    const deployment = await registry.get(id);
    expect(deployment?.agentServerPid).toBe(10_000);
    expect((deployment as Record<string, unknown>)?.gatewayPid).toBeUndefined();
  });

  it('exit handler updates registry to stopped when agent server exits', async () => {
    const { spawner, processes } = createMockSpawner();
    const successWatcher: StartupWatcher = async () => ({ success: true });
    const runtime = new ProcessRuntime(
      registry,
      secrets,
      '/fake/root',
      spawner,
      undefined,
      successWatcher,
    );

    const id = await runtime.deploy(configDir);

    const [agentServer] = processes;
    agentServer.exitCode = 0;
    agentServer.emit('exit', 0, null);

    // Wait for async registry update
    await new Promise((r) => setTimeout(r, 50));

    const deployment = await registry.get(id);
    expect(deployment?.status).toBe('stopped');
  });

  it('stop() kills agent server and updates registry', async () => {
    const { spawner, processes } = createMockSpawner();
    const successWatcher: StartupWatcher = async () => ({ success: true });
    const runtime = new ProcessRuntime(
      registry,
      secrets,
      '/fake/root',
      spawner,
      undefined,
      successWatcher,
    );

    const id = await runtime.deploy(configDir);
    await runtime.stop(id);

    const [agentServer] = processes;
    expect(agentServer.killed).toBe(true);
    expect(processes).toHaveLength(1);

    const deployment = await registry.get(id);
    expect(deployment?.status).toBe('stopped');
  });

  it('getStatus() returns running with agentServerPid only', async () => {
    const { spawner } = createMockSpawner();
    const successWatcher: StartupWatcher = async () => ({ success: true });
    const runtime = new ProcessRuntime(
      registry,
      secrets,
      '/fake/root',
      spawner,
      undefined,
      successWatcher,
    );

    const id = await runtime.deploy(configDir);
    const status = await runtime.getStatus(id);

    expect(status.state).toBe('running');
    expect(status.agentServerPid).toBe(10_000);
    expect((status as Record<string, unknown>).gatewayPid).toBeUndefined();
    expect(status.uptime).toBeGreaterThanOrEqual(0);
  });

  it('getStatus() returns stopped after agent server exits', async () => {
    const { spawner, processes } = createMockSpawner();
    const successWatcher: StartupWatcher = async () => ({ success: true });
    const runtime = new ProcessRuntime(
      registry,
      secrets,
      '/fake/root',
      spawner,
      undefined,
      successWatcher,
    );

    const id = await runtime.deploy(configDir);

    const [agentServer] = processes;
    agentServer.exitCode = 0;
    agentServer.emit('exit', 0, null);

    await new Promise((r) => setTimeout(r, 50));

    const status = await runtime.getStatus(id);
    expect(status.state).toBe('stopped');
  });

  it('stop() uses PID-based kill when not tracked in memory', async () => {
    const { spawner } = createMockSpawner();
    const successWatcher: StartupWatcher = async () => ({ success: true });
    const runtime = new ProcessRuntime(
      registry,
      secrets,
      '/fake/root',
      spawner,
      undefined,
      successWatcher,
    );
    const id = await runtime.deploy(configDir);

    // Fresh runtime simulates MC restart — no in-memory process state
    const runtime2 = new ProcessRuntime(
      registry,
      secrets,
      '/fake/root',
      spawner,
      undefined,
      successWatcher,
    );

    const killed: { pid: number | bigint; signal: unknown }[] = [];
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      killed.push({ pid, signal });
      if (signal === 0) throw new Error('ESRCH'); // Simulate dead process on liveness check
      return true;
    });

    try {
      await runtime2.stop(id);
    } finally {
      killSpy.mockRestore();
    }

    expect(killed.some((k) => k.pid === 10_000 && k.signal === 'SIGTERM')).toBe(true);
    // No gateway PID kill
    expect(killed.filter((k) => k.signal === 'SIGTERM')).toHaveLength(1);

    const deployment = await registry.get(id);
    expect(deployment?.status).toBe('stopped');
  });

  it('remove() stops, cleans secrets, and removes from registry', async () => {
    const { spawner } = createMockSpawner();
    const successWatcher: StartupWatcher = async () => ({ success: true });
    const runtime = new ProcessRuntime(
      registry,
      secrets,
      '/fake/root',
      spawner,
      undefined,
      successWatcher,
    );

    const id = await runtime.deploy(configDir);
    await runtime.remove(id);

    const deployment = await registry.get(id);
    expect(deployment).toBeNull();

    expect(await secrets.get(`agent-token:${id}`)).toBeNull();
    expect(await secrets.get(`chat-token:${id}`)).toBeNull();
  });
});

describe('waitForStartup', () => {
  it('resolves success when health check passes and Server ready line seen', async () => {
    const proc = new FakeProcess(1234);
    let healthCallCount = 0;

    const mockHealthCheck = async (): Promise<boolean> => {
      healthCallCount++;
      return healthCallCount >= 2; // passes on second call
    };

    const resultPromise = waitForStartup(proc, 9100, 5000, mockHealthCheck);

    // Emit the ready log line after a tick
    await new Promise((r) => setTimeout(r, 10));
    proc.simulateLog('Server ready');

    const result = await resultPromise;
    expect(result.success).toBe(true);
  });

  it('fails if process exits before startup', async () => {
    const proc = new FakeProcess(1234);
    const mockHealthCheck = async (): Promise<boolean> => false;

    const resultPromise = waitForStartup(proc, 9100, 5000, mockHealthCheck);

    await new Promise((r) => setTimeout(r, 10));
    proc.simulateExit(1);

    const result = await resultPromise;
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toContain('exited');
    }
  });

  it('fails with timeout when neither health nor log line seen', async () => {
    const proc = new FakeProcess(1234);
    const mockHealthCheck = async (): Promise<boolean> => false;

    const result = await waitForStartup(proc, 9100, 200, mockHealthCheck); // 200ms timeout
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toContain('timeout');
    }
  });

  it('captures log lines in failure result', async () => {
    const proc = new FakeProcess(1234);
    const mockHealthCheck = async (): Promise<boolean> => false;

    const resultPromise = waitForStartup(proc, 9100, 200, mockHealthCheck);

    await new Promise((r) => setTimeout(r, 10));
    proc.simulateLog('[12:00:00] Loading config');
    proc.simulateLog('[12:00:00] Error: something failed');

    const result = await resultPromise;
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.logs.some((l) => l.includes('Loading config'))).toBe(true);
    }
  });
});

describe('ProcessRuntime.deploy() startup watcher', () => {
  let tmpDir: string;
  let configDir: string;
  let registry: AgentRegistry;
  let secrets: SecretStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'mc-startup-'));
    configDir = await mkdtemp(join(tmpdir(), 'mc-startup-cfg-'));
    await mkdir(join(configDir, 'agents'));
    await writeFile(
      join(configDir, 'agents', 'my-agent.json'),
      JSON.stringify({ name: 'my-agent', model: 'claude-sonnet-4-20250514', systemPrompt: 'hi' }),
    );
    registry = new AgentRegistry(tmpDir);
    secrets = createMockSecrets();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true });
    await rm(configDir, { recursive: true });
  });

  it('registers with provisioning status during startup', async () => {
    const { spawner } = createMockSpawner();
    let provisioningStatusSeen = false;

    const slowWatcher: StartupWatcher = async () => {
      const deployments = await registry.list();
      if (deployments.some((d) => d.status === 'provisioning')) {
        provisioningStatusSeen = true;
      }
      return { success: true };
    };

    const runtime = new ProcessRuntime(
      registry,
      secrets,
      '/fake/root',
      spawner,
      undefined,
      slowWatcher,
    );
    await runtime.deploy(configDir);

    expect(provisioningStatusSeen).toBe(true);
    const deployments = await registry.list();
    expect(deployments[0].status).toBe('running');
  });

  it('registers as running on startup success', async () => {
    const { spawner } = createMockSpawner();
    const successWatcher: StartupWatcher = async () => ({ success: true });
    const runtime = new ProcessRuntime(
      registry,
      secrets,
      '/fake/root',
      spawner,
      undefined,
      successWatcher,
    );

    const id = await runtime.deploy(configDir);

    const deployment = await registry.get(id);
    expect(deployment?.status).toBe('running');
  });

  it('registers as error on startup failure and throws DeploymentStartupError', async () => {
    const { spawner } = createMockSpawner();
    const failWatcher: StartupWatcher = async () => ({
      success: false,
      logs: ['[err] Something went wrong'],
      reason: 'timeout after 10000ms',
    });
    const runtime = new ProcessRuntime(
      registry,
      secrets,
      '/fake/root',
      spawner,
      undefined,
      failWatcher,
    );

    await expect(runtime.deploy(configDir)).rejects.toThrow(DeploymentStartupError);

    const deployments = await registry.list();
    expect(deployments).toHaveLength(1);
    expect(deployments[0].status).toBe('error');
    expect(deployments[0].errorMessage).toBe('timeout after 10000ms');
    expect(deployments[0].startupLogs).toEqual(['[err] Something went wrong']);
  });

  it('kills the process on startup failure', async () => {
    const { spawner, processes } = createMockSpawner();
    const failWatcher: StartupWatcher = async () => ({
      success: false,
      logs: [],
      reason: 'process exited with code 1',
    });
    const runtime = new ProcessRuntime(
      registry,
      secrets,
      '/fake/root',
      spawner,
      undefined,
      failWatcher,
    );

    await expect(runtime.deploy(configDir)).rejects.toThrow(DeploymentStartupError);

    expect(processes[0].killed).toBe(true);
  });
});

describe('ProcessRuntime.ensureGatewayRunning', () => {
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
      JSON.stringify({ name: 'test-agent', model: 'claude-sonnet-4-20250514', systemPrompt: 'hi' }),
    );
    registry = new AgentRegistry(tmpDir);
    secrets = createMockSecrets();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true });
    await rm(configDir, { recursive: true });
  });

  it('deploy() spawns only one process (agent server, no gateway)', async () => {
    const { spawner, processes } = createMockSpawner();
    const successWatcher: StartupWatcher = async () => ({ success: true });

    const mockGatewayClient = {
      health: vi.fn().mockResolvedValue({
        status: 'healthy',
        startedAt: '2026-01-01T00:00:00Z',
        agents: 0,
        channels: 0,
      }),
      registerAgent: vi.fn().mockResolvedValue(undefined),
      registerChannel: vi.fn().mockResolvedValue(undefined),
      deregisterDeployment: vi.fn().mockResolvedValue(undefined),
    };

    const { GatewayStateStore } = await import('./gateway-state.js');
    const store = new GatewayStateStore(tmpDir);
    await store.write({
      pid: process.pid,
      startedAt: '2026-01-01T00:00:00Z',
      token: 'gw-tok',
      port: 9300,
    });

    const runtime = new ProcessRuntime(
      registry,
      secrets,
      '/fake/root',
      spawner,
      undefined,
      successWatcher,
      {
        gatewayDataDir: tmpDir,
        makeGatewayClient: () => mockGatewayClient as GatewayManagementClient,
      },
    );

    await runtime.deploy(configDir);

    expect(processes).toHaveLength(1);
    expect(mockGatewayClient.registerAgent).toHaveBeenCalled();
  });

  it('stop() calls deregisterDeployment on gateway', async () => {
    const { spawner } = createMockSpawner();
    const successWatcher: StartupWatcher = async () => ({ success: true });

    const mockGatewayClient = {
      health: vi.fn().mockResolvedValue({
        status: 'healthy',
        startedAt: '2026-01-01T00:00:00Z',
        agents: 0,
        channels: 0,
      }),
      registerAgent: vi.fn().mockResolvedValue(undefined),
      registerChannel: vi.fn().mockResolvedValue(undefined),
      deregisterDeployment: vi.fn().mockResolvedValue(undefined),
    };

    const { GatewayStateStore } = await import('./gateway-state.js');
    const store = new GatewayStateStore(tmpDir);
    await store.write({
      pid: process.pid,
      startedAt: '2026-01-01T00:00:00Z',
      token: 'gw-tok',
      port: 9300,
    });

    const runtime = new ProcessRuntime(
      registry,
      secrets,
      '/fake/root',
      spawner,
      undefined,
      successWatcher,
      {
        gatewayDataDir: tmpDir,
        makeGatewayClient: () => mockGatewayClient as GatewayManagementClient,
      },
    );

    const id = await runtime.deploy(configDir);
    await runtime.stop(id);

    expect(mockGatewayClient.deregisterDeployment).toHaveBeenCalledWith(id);
  });
});
