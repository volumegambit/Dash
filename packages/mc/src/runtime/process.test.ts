import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GatewayManagementClient } from './gateway-client.js';
import {
  GatewaySupervisor,
  type GatewaySupervisorOptions,
  type ProcessKiller,
  type ProcessSpawner,
} from './process.js';

/**
 * Create a mock ProcessKiller backed by a set of "alive" pids. Tests use
 * this instead of the real `process.kill` so they can write state files
 * that reference `process.pid` (as a guaranteed alive PID) without
 * actually signalling the test runner.
 */
function createMockKiller(aliveSet = new Set<number>()): ProcessKiller & {
  isAlive: ReturnType<typeof vi.fn>;
  signal: ReturnType<typeof vi.fn>;
  aliveSet: Set<number>;
} {
  const killer = {
    aliveSet,
    isAlive: vi.fn((pid: number) => aliveSet.has(pid)),
    signal: vi.fn((pid: number, _sig: NodeJS.Signals) => {
      // Simulate SIGTERM: immediately mark the pid as dead so the
      // shutdown wait loop in GatewaySupervisor exits promptly.
      aliveSet.delete(pid);
    }),
  };
  return killer;
}

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
    // `ensureRunning()` calls `listAgents()` to verify the auth token works
    // (the /health endpoint is unauthenticated, so a matching startedAt
    // alone doesn't prove our token is still valid). Must be stubbed here
    // or the reuse path silently falls through to a fresh spawn.
    listAgents: vi.fn().mockResolvedValue([]),
  } as unknown as GatewayManagementClient & {
    health: ReturnType<typeof vi.fn>;
    listAgents: ReturnType<typeof vi.fn>;
  };
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
  overrides: Partial<GatewaySupervisorOptions> = {},
): GatewaySupervisorOptions {
  return {
    gatewayDataDir: tmpDir,
    projectRoot: '/fake/root',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// GatewaySupervisor.ensureRunning()
// ---------------------------------------------------------------------------

describe('GatewaySupervisor.ensureRunning()', () => {
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

    const gp = new GatewaySupervisor(
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
    const { GatewayStateStore } = await import('./gateway-state.js');
    const store = new GatewayStateStore(tmpDir);
    await store.write({
      pid: 12345,
      startedAt: '2026-01-01T00:00:00Z',
      token: 'existing-token',
      port: 9300,
      channelPort: 9200,
      chatToken: 'existing-chat-token',
    });

    const mockClient = createMockGatewayClient('2026-01-01T00:00:00Z');
    const spawner = createMockSpawner();
    const killer = createMockKiller(new Set([12345]));

    const gp = new GatewaySupervisor(
      makeOptions(tmpDir, { makeGatewayClient: () => mockClient }),
      spawner,
      killer,
    );

    const client = await gp.ensureRunning();

    // Should NOT spawn a new process
    expect(spawner.spawn).not.toHaveBeenCalled();
    expect(killer.signal).not.toHaveBeenCalled();
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

    const gp = new GatewaySupervisor(
      makeOptions(tmpDir, { makeGatewayClient: () => mockClient }),
      spawner,
    );

    const client = await gp.ensureRunning();

    expect(spawner.spawn).toHaveBeenCalledOnce();
    expect(client).toBe(mockClient);
  });

  it('respawns and kills stale PID when health check startedAt does not match', async () => {
    const { GatewayStateStore } = await import('./gateway-state.js');
    const store = new GatewayStateStore(tmpDir);
    await store.write({
      pid: 11111,
      startedAt: '2026-01-01T00:00:00Z', // different from what health returns
      token: 'old-token',
      port: 9300,
      channelPort: 9200,
      chatToken: 'old-chat-token',
    });

    // Health returns a different startedAt — gateway was restarted externally
    const mockClient = createMockGatewayClient('2026-03-01T00:00:00Z');
    const spawner = createMockSpawner(54321);
    const killer = createMockKiller(new Set([11111]));

    const gp = new GatewaySupervisor(
      makeOptions(tmpDir, { makeGatewayClient: () => mockClient }),
      spawner,
      killer,
    );

    const client = await gp.ensureRunning();

    // Must kill the stale process BEFORE spawning, otherwise the new
    // spawn collides on port 9300 with EADDRINUSE.
    expect(killer.signal).toHaveBeenCalledWith(11111, 'SIGTERM');
    expect(spawner.spawn).toHaveBeenCalledOnce();
    expect(client).toBe(mockClient);
  });

  it('respawns and kills stale PID when auth token is rejected (EADDRINUSE regression)', async () => {
    // This is the regression test for the respawn-loop scenario where
    // MC's in-memory token no longer matches the running gateway's
    // token. The old code fell through to `spawn` without killing the
    // stale process, causing EADDRINUSE on every subsequent attempt.
    const { GatewayStateStore } = await import('./gateway-state.js');
    const store = new GatewayStateStore(tmpDir);
    await store.write({
      pid: 22222,
      startedAt: '2026-01-01T00:00:00Z',
      token: 'stale-token',
      port: 9300,
      channelPort: 9200,
      chatToken: 'stale-chat-token',
    });

    // Health check succeeds with matching startedAt, but listAgents
    // rejects with a 401 because the running gateway's token has drifted.
    const mockClient = {
      health: vi.fn().mockResolvedValue({
        status: 'healthy',
        startedAt: '2026-01-01T00:00:00Z',
        agents: 0,
        channels: 0,
      }),
      listAgents: vi.fn().mockRejectedValue(new Error('Gateway listAgents failed: 401 Unauthorized')),
    } as unknown as GatewayManagementClient;

    // After the kill + spawn, `ensureRunning` creates a fresh client —
    // the factory returns a healthy one with no auth failures.
    const freshClient = createMockGatewayClient('2026-04-01T00:00:00Z');
    let callCount = 0;
    const makeGatewayClient = vi.fn(() => {
      callCount++;
      return callCount === 1 ? mockClient : freshClient;
    });

    const spawner = createMockSpawner(54321);
    const killer = createMockKiller(new Set([22222]));

    const gp = new GatewaySupervisor(
      makeOptions(tmpDir, { makeGatewayClient }),
      spawner,
      killer,
    );

    const client = await gp.ensureRunning();

    // The stale process MUST be killed before spawning
    expect(killer.signal).toHaveBeenCalledWith(22222, 'SIGTERM');
    // Fresh gateway process must be spawned
    expect(spawner.spawn).toHaveBeenCalledOnce();
    // The returned client is the fresh one, not the stale one
    expect(client).toBe(freshClient);
  });

  it('throws when gateway does not become healthy within timeout', async () => {
    const failingClient = {
      health: vi.fn().mockRejectedValue(new Error('connection refused')),
    } as unknown as GatewayManagementClient;

    const spawner = createMockSpawner();

    const gp = new GatewaySupervisor(
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

    const gp = new GatewaySupervisor(
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
// GatewaySupervisor.getClient()
// ---------------------------------------------------------------------------

describe('GatewaySupervisor.getClient()', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'gw-client-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true });
  });

  it('returns null when no state exists', async () => {
    const gp = new GatewaySupervisor(makeOptions(tmpDir));
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
    const gp = new GatewaySupervisor(makeOptions(tmpDir, { makeGatewayClient: () => mockClient }));

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
    const gp = new GatewaySupervisor(
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
