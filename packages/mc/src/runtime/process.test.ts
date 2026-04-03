import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GatewayManagementClient } from './gateway-client.js';
import { GatewayProcess, type GatewayProcessOptions, type ProcessSpawner } from './process.js';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockGatewayClient(startedAt = '2026-01-01T00:00:00Z') {
  return {
    health: vi.fn().mockResolvedValue({
      status: 'healthy',
      startedAt,
      agents: 0,
      channels: 0,
    }),
  } as unknown as GatewayManagementClient & { health: ReturnType<typeof vi.fn> };
}

function createMockSpawner(pid = 12345): ProcessSpawner {
  return {
    spawn: vi.fn().mockReturnValue({
      pid,
      exitCode: null,
      stdout: null,
      stderr: null,
      kill: vi.fn(),
      on: vi.fn(),
      unref: vi.fn(),
    }),
  };
}

function makeOptions(
  tmpDir: string,
  overrides: Partial<GatewayProcessOptions> = {},
): GatewayProcessOptions {
  return {
    gatewayDataDir: tmpDir,
    projectRoot: '/fake/root',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// GatewayProcess.ensureRunning()
// ---------------------------------------------------------------------------

describe('GatewayProcess.ensureRunning()', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'gw-process-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true });
  });

  it('spawns gateway when no state exists', async () => {
    const mockClient = createMockGatewayClient();
    const spawner = createMockSpawner();

    const gp = new GatewayProcess(
      makeOptions(tmpDir, { makeGatewayClient: () => mockClient }),
      spawner,
    );

    const client = await gp.ensureRunning();

    expect(spawner.spawn).toHaveBeenCalledOnce();
    expect(spawner.spawn).toHaveBeenCalledWith(
      'node',
      expect.arrayContaining([expect.stringContaining('apps/gateway/dist/index.js')]),
      expect.objectContaining({ detached: true }),
    );
    expect(client).toBe(mockClient);
  });

  it('reuses existing gateway when PID is alive and health matches', async () => {
    // Write state pointing to current process (always alive)
    const { GatewayStateStore } = await import('./gateway-state.js');
    const store = new GatewayStateStore(tmpDir);
    await store.write({
      pid: process.pid,
      startedAt: '2026-01-01T00:00:00Z',
      token: 'existing-token',
      port: 9300,
      channelPort: 9200,
      chatToken: 'existing-chat-token',
    });

    const mockClient = createMockGatewayClient('2026-01-01T00:00:00Z');
    const spawner = createMockSpawner();

    const gp = new GatewayProcess(
      makeOptions(tmpDir, { makeGatewayClient: () => mockClient }),
      spawner,
    );

    const client = await gp.ensureRunning();

    // Should NOT spawn a new process
    expect(spawner.spawn).not.toHaveBeenCalled();
    expect(client).toBe(mockClient);
  });

  it('respawns when existing gateway PID is dead', async () => {
    // Write state with a dead PID
    const { GatewayStateStore } = await import('./gateway-state.js');
    const store = new GatewayStateStore(tmpDir);
    await store.write({
      pid: 999999999, // very unlikely to be alive
      startedAt: '2026-01-01T00:00:00Z',
      token: 'old-token',
      port: 9300,
      channelPort: 9200,
      chatToken: 'old-chat-token',
    });

    const mockClient = createMockGatewayClient('2026-02-01T00:00:00Z');
    const spawner = createMockSpawner(54321);

    const gp = new GatewayProcess(
      makeOptions(tmpDir, { makeGatewayClient: () => mockClient }),
      spawner,
    );

    const client = await gp.ensureRunning();

    expect(spawner.spawn).toHaveBeenCalledOnce();
    expect(client).toBe(mockClient);
  });

  it('respawns when health check startedAt does not match state', async () => {
    // Write state pointing to current process but with a different startedAt
    const { GatewayStateStore } = await import('./gateway-state.js');
    const store = new GatewayStateStore(tmpDir);
    await store.write({
      pid: process.pid,
      startedAt: '2026-01-01T00:00:00Z', // different from what health returns
      token: 'old-token',
      port: 9300,
      channelPort: 9200,
      chatToken: 'old-chat-token',
    });

    // Health returns a different startedAt — gateway was restarted externally
    const mockClient = createMockGatewayClient('2026-03-01T00:00:00Z');
    const spawner = createMockSpawner(54321);

    const gp = new GatewayProcess(
      makeOptions(tmpDir, { makeGatewayClient: () => mockClient }),
      spawner,
    );

    const client = await gp.ensureRunning();

    expect(spawner.spawn).toHaveBeenCalledOnce();
    expect(client).toBe(mockClient);
  });

  it('throws when gateway does not become healthy within timeout', async () => {
    const failingClient = {
      health: vi.fn().mockRejectedValue(new Error('connection refused')),
    } as unknown as GatewayManagementClient;

    const spawner = createMockSpawner();

    const gp = new GatewayProcess(
      makeOptions(tmpDir, { makeGatewayClient: () => failingClient }),
      spawner,
    );

    // Override timeout for speed — patch the deadline by providing a very short window
    // We can't easily override Date.now, so just verify the error message
    await expect(gp.ensureRunning()).rejects.toThrow('Gateway failed to start within 10s');
  }, 15_000);

  it('passes --data-dir when gatewayRuntimeDir is set', async () => {
    const mockClient = createMockGatewayClient();
    const spawner = createMockSpawner();

    const gp = new GatewayProcess(
      makeOptions(tmpDir, {
        makeGatewayClient: () => mockClient,
        gatewayRuntimeDir: '/custom/data/dir',
      }),
      spawner,
    );

    await gp.ensureRunning();

    expect(spawner.spawn).toHaveBeenCalledWith(
      'node',
      expect.arrayContaining(['--data-dir', '/custom/data/dir']),
      expect.anything(),
    );
  });
});

// ---------------------------------------------------------------------------
// GatewayProcess.getClient()
// ---------------------------------------------------------------------------

describe('GatewayProcess.getClient()', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'gw-client-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true });
  });

  it('returns null when no state exists', async () => {
    const gp = new GatewayProcess(makeOptions(tmpDir));
    const client = await gp.getClient();
    expect(client).toBeNull();
  });

  it('returns client when state exists', async () => {
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

    const mockClient = createMockGatewayClient();
    const gp = new GatewayProcess(
      makeOptions(tmpDir, { makeGatewayClient: () => mockClient }),
    );

    const client = await gp.getClient();
    expect(client).toBe(mockClient);
  });

  it('constructs client with correct base URL from state port', async () => {
    const { GatewayStateStore } = await import('./gateway-state.js');
    const store = new GatewayStateStore(tmpDir);
    await store.write({
      pid: process.pid,
      startedAt: '2026-01-01T00:00:00Z',
      token: 'my-token',
      port: 9400,
      channelPort: 9500,
      chatToken: 'chat-tok',
    });

    let capturedUrl = '';
    let capturedToken = '';
    const gp = new GatewayProcess(
      makeOptions(tmpDir, {
        makeGatewayClient: (url, token) => {
          capturedUrl = url;
          capturedToken = token;
          return createMockGatewayClient();
        },
      }),
    );

    await gp.getClient();
    expect(capturedUrl).toBe('http://localhost:9400');
    expect(capturedToken).toBe('my-token');
  });
});
