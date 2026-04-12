import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GatewayHttpError, type GatewayManagementClient } from './gateway-client.js';
import {
  GatewaySupervisor,
  type GatewaySupervisorOptions,
  type PortOwnerProbe,
  type PortOwnerProbeResult,
  type ProcessKiller,
  type ProcessSpawner,
} from './process.js';

/**
 * Build a mock `PortOwnerProbe` that returns the given probe result.
 * Defaults to `{ type: 'free' }` — the "clean start" scenario where
 * nothing is listening. Tests that exercise the reuse path pass
 * `{ type: 'owner', startedAt, pid }` with a matching `startedAt`;
 * reconcile-path tests pass a drifted `startedAt` or a mismatched
 * `pid`; transient-failure tests pass `{ type: 'unknown', reason }`.
 */
function createMockProbe(
  result: PortOwnerProbeResult = { type: 'free' },
): PortOwnerProbe & ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue(result) as PortOwnerProbe & ReturnType<typeof vi.fn>;
}

/** Sugar for the common "gateway is there and matches state" probe result. */
function probeOwner(startedAt: string, pid?: number): PortOwnerProbeResult {
  return { type: 'owner', startedAt, pid };
}

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

  async function writeState(pid: number, startedAt: string, token = 'tok') {
    const { GatewayStateStore } = await import('./gateway-state.js');
    const store = new GatewayStateStore(tmpDir);
    await store.write({
      pid,
      startedAt,
      token,
      port: 9300,
      channelPort: 9200,
      chatToken: 'chat-tok',
    });
    return store;
  }

  // ------------------------------------------------------------------
  // Clean spawn path: nothing on the port, no state
  // ------------------------------------------------------------------

  it('spawns gateway when no state exists and port is free', async () => {
    const mockClient = createMockGatewayClient();
    const spawner = createMockSpawner();
    const probe = createMockProbe({ type: 'free' });

    const gp = new GatewaySupervisor(
      makeOptions(tmpDir, { makeGatewayClient: () => mockClient }),
      spawner,
      undefined,
      probe,
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

  it('passes --data-dir when gatewayRuntimeDir is set', async () => {
    const spawner = createMockSpawner();
    const probe = createMockProbe({ type: 'free' });

    const gp = new GatewaySupervisor(
      makeOptions(tmpDir, {
        makeGatewayClient: () => createMockGatewayClient(),
        gatewayRuntimeDir: '/custom/data/dir',
      }),
      spawner,
      undefined,
      probe,
    );

    await gp.ensureRunning();

    expect(spawner.spawn).toHaveBeenCalledWith(
      'node',
      expect.arrayContaining(['--data-dir', '/custom/data/dir']),
      expect.anything(),
    );
  });

  // ------------------------------------------------------------------
  // Reuse path: token works — don't spawn, don't kill
  // ------------------------------------------------------------------

  it('reuses existing gateway when our token authenticates successfully', async () => {
    // Token match is the AUTHORITATIVE identity signal — a successful
    // listAgents() is cryptographic proof this is the gateway we
    // spawned (tokens are 256-bit random per spawn). The supervisor
    // MUST reuse without spawning in this case.
    await writeState(12345, '2026-01-01T00:00:00Z', 'existing-token');

    const mockClient = createMockGatewayClient('2026-01-01T00:00:00Z');
    const spawner = createMockSpawner();
    const killer = createMockKiller(new Set([12345]));
    const probe = createMockProbe(probeOwner('2026-01-01T00:00:00Z', 12345));

    const gp = new GatewaySupervisor(
      makeOptions(tmpDir, { makeGatewayClient: () => mockClient }),
      spawner,
      killer,
      probe,
    );

    const client = await gp.ensureRunning();

    expect(spawner.spawn).not.toHaveBeenCalled();
    expect(killer.signal).not.toHaveBeenCalled();
    expect(client).toBe(mockClient);
    // Verify auth actually ran — the reuse decision must be based on
    // a real auth check, not optimistic state.json trust.
    expect((mockClient as unknown as { listAgents: { mock: { calls: unknown[] } } }).listAgents.mock.calls.length).toBe(1);
  });

  it('reuses even when state.startedAt does not match probe.startedAt, as long as auth works', async () => {
    // Guard against over-eager respawn: if our token still works
    // (authoritative proof of identity), we should reuse even if
    // startedAt or pid in state.json have drifted for unrelated
    // reasons. Only a 401 should trigger a respawn.
    await writeState(12345, '2026-01-01T00:00:00Z', 'still-valid-token');

    const mockClient = createMockGatewayClient('2026-02-02T02:02:02Z');
    const spawner = createMockSpawner();
    const killer = createMockKiller(new Set([12345]));
    // Probe returns DIFFERENT startedAt, but listAgents will succeed
    const probe = createMockProbe(probeOwner('2026-02-02T02:02:02Z', 12345));

    const gp = new GatewaySupervisor(
      makeOptions(tmpDir, { makeGatewayClient: () => mockClient }),
      spawner,
      killer,
      probe,
    );

    const client = await gp.ensureRunning();

    expect(spawner.spawn).not.toHaveBeenCalled();
    expect(killer.signal).not.toHaveBeenCalled();
    expect(client).toBe(mockClient);
  });

  // ------------------------------------------------------------------
  // Dead-gateway path: state references a process but nobody is on the port
  // ------------------------------------------------------------------

  it('respawns when state references a gateway that is no longer on the port', async () => {
    await writeState(999999999, '2026-01-01T00:00:00Z');

    const mockClient = createMockGatewayClient('2026-02-01T00:00:00Z');
    const spawner = createMockSpawner(54321);
    const probe = createMockProbe({ type: 'free' });

    const gp = new GatewaySupervisor(
      makeOptions(tmpDir, { makeGatewayClient: () => mockClient }),
      spawner,
      undefined,
      probe,
    );

    await gp.ensureRunning();

    expect(spawner.spawn).toHaveBeenCalledOnce();
  });

  // ------------------------------------------------------------------
  // Orphan path: port held by somebody else's gateway (token mismatch)
  // → kill the REAL port owner (probe.pid), not state.pid
  // ------------------------------------------------------------------

  it('kills the port owner PID (not state.pid) when a different gateway holds the port', async () => {
    // state.json says pid=11111 but the actual orphan on the port is
    // pid=99785 (PID reported by /health). The supervisor MUST kill
    // 99785, not 11111 — killing the wrong pid was the exact bug
    // that caused the user-visible respawn loop.
    await writeState(11111, '2026-01-01T00:00:00Z', 'stale-token');

    const staleClient = {
      listAgents: vi
        .fn()
        .mockRejectedValue(new GatewayHttpError(401, 'listAgents', 'Unauthorized')),
    } as unknown as GatewayManagementClient;
    const freshClient = createMockGatewayClient('2026-04-01T00:00:00Z');
    let call = 0;
    const makeGatewayClient = vi.fn(() => (call++ === 0 ? staleClient : freshClient));

    const spawner = createMockSpawner(54321);
    const killer = createMockKiller(new Set([11111, 99785]));
    // probe.pid = 99785 (real port owner), different from state.pid=11111
    const probe = createMockProbe(probeOwner('2026-03-01T00:00:00Z', 99785));

    const gp = new GatewaySupervisor(
      makeOptions(tmpDir, { makeGatewayClient }),
      spawner,
      killer,
      probe,
    );

    await gp.ensureRunning();

    // MUST kill the PID from the probe, not the PID from state.json
    expect(killer.signal).toHaveBeenCalledWith(99785, 'SIGTERM');
    expect(killer.signal).not.toHaveBeenCalledWith(11111, 'SIGTERM');
    expect(spawner.spawn).toHaveBeenCalledOnce();
  });

  // ------------------------------------------------------------------
  // Auth path: startedAt matches but token drifted
  // ------------------------------------------------------------------

  it('respawns and kills stale PID when auth token is rejected (EADDRINUSE regression)', async () => {
    await writeState(22222, '2026-01-01T00:00:00Z', 'stale-token');

    const staleClient = {
      health: vi.fn().mockResolvedValue({
        status: 'healthy',
        startedAt: '2026-01-01T00:00:00Z',
        agents: 0,
        channels: 0,
      }),
      listAgents: vi
        .fn()
        .mockRejectedValue(new GatewayHttpError(401, 'listAgents', 'Unauthorized')),
    } as unknown as GatewayManagementClient;
    const freshClient = createMockGatewayClient('2026-04-01T00:00:00Z');
    let call = 0;
    const makeGatewayClient = vi.fn(() => (call++ === 0 ? staleClient : freshClient));

    const spawner = createMockSpawner(54321);
    const killer = createMockKiller(new Set([22222]));
    const probe = createMockProbe(probeOwner('2026-01-01T00:00:00Z', 22222));

    const gp = new GatewaySupervisor(
      makeOptions(tmpDir, { makeGatewayClient }),
      spawner,
      killer,
      probe,
    );

    const client = await gp.ensureRunning();

    expect(killer.signal).toHaveBeenCalledWith(22222, 'SIGTERM');
    expect(spawner.spawn).toHaveBeenCalledOnce();
    expect(client).toBe(freshClient);
  });

  // ------------------------------------------------------------------
  // Orphan-gateway path: no state but the port is held
  // ------------------------------------------------------------------

  it('kills untracked orphan gateway when no state exists but port is occupied', async () => {
    // Fresh MC install scenario: no state.json, but there's an orphan
    // gateway on port 9300 (inherited by init from an earlier process).
    const spawner = createMockSpawner(54321);
    const killer = createMockKiller(new Set([88888]));
    const probe = createMockProbe(probeOwner('2026-01-01T00:00:00Z', 88888));

    const gp = new GatewaySupervisor(
      makeOptions(tmpDir, {
        makeGatewayClient: () => createMockGatewayClient('2026-04-01T00:00:00Z'),
      }),
      spawner,
      killer,
      probe,
    );

    await gp.ensureRunning();

    expect(killer.signal).toHaveBeenCalledWith(88888, 'SIGTERM');
    expect(spawner.spawn).toHaveBeenCalledOnce();
  });

  it('throws if no state and orphan gateway does not expose pid in /health', async () => {
    // If an older gateway (without the pid-in-health fix) is on the
    // port and we have no state.json to fall back to, we cannot
    // safely identify the listener. Fail loudly rather than SIGKILL
    // a random PID or spawn into a collision.
    const spawner = createMockSpawner();
    const probe = createMockProbe({ type: 'owner', startedAt: '2026-01-01T00:00:00Z' });

    const gp = new GatewaySupervisor(
      makeOptions(tmpDir, { makeGatewayClient: () => createMockGatewayClient() }),
      spawner,
      undefined,
      probe,
    );

    await expect(gp.ensureRunning()).rejects.toThrow(/can't identify/);
    expect(spawner.spawn).not.toHaveBeenCalled();
  });

  // ------------------------------------------------------------------
  // Transient-failure path: probe returns `unknown`
  // ------------------------------------------------------------------

  it('propagates unknown probe result WITHOUT killing or respawning', async () => {
    // Probe returns `unknown` when the listener is unresponsive:
    // timeout, non-JSON, missing startedAt, 5xx. Crucial that we do
    // NOT spawn or kill — acting on `unknown` is how the respawn
    // loop started in the first place.
    const store = await writeState(33333, '2026-01-01T00:00:00Z');

    const mockClient = createMockGatewayClient('2026-01-01T00:00:00Z');
    const spawner = createMockSpawner();
    const killer = createMockKiller(new Set([33333]));
    const probe = createMockProbe({ type: 'unknown', reason: '/health timeout' });

    const gp = new GatewaySupervisor(
      makeOptions(tmpDir, { makeGatewayClient: () => mockClient }),
      spawner,
      killer,
      probe,
    );

    await expect(gp.ensureRunning()).rejects.toThrow(/unresponsive/);

    expect(killer.signal).not.toHaveBeenCalled();
    expect(spawner.spawn).not.toHaveBeenCalled();
    // State is preserved — next call can reuse if the blip clears.
    const stateAfter = await store.read();
    expect(stateAfter?.pid).toBe(33333);
  });

  it('propagates transient listAgents() 503 WITHOUT killing or respawning', async () => {
    await writeState(44444, '2026-01-01T00:00:00Z', 'existing-token');

    const mockClient = {
      listAgents: vi
        .fn()
        .mockRejectedValue(new GatewayHttpError(503, 'listAgents', 'temporarily unavailable')),
    } as unknown as GatewayManagementClient;

    const spawner = createMockSpawner();
    const killer = createMockKiller(new Set([44444]));
    const probe = createMockProbe(probeOwner('2026-01-01T00:00:00Z', 44444));

    const gp = new GatewaySupervisor(
      makeOptions(tmpDir, { makeGatewayClient: () => mockClient }),
      spawner,
      killer,
      probe,
    );

    await expect(gp.ensureRunning()).rejects.toThrow(/503/);

    expect(killer.signal).not.toHaveBeenCalled();
    expect(spawner.spawn).not.toHaveBeenCalled();
  });

  // ------------------------------------------------------------------
  // Startup-health-timeout path: spawn succeeded but new gateway never
  // becomes healthy. The spawned child must be SIGKILL'd (zombie
  // cleanup) so it doesn't keep holding the port.
  // ------------------------------------------------------------------

  it('throws and SIGKILLs spawned child when gateway never becomes healthy', async () => {
    const failingClient = {
      health: vi.fn().mockRejectedValue(new Error('connection refused')),
    } as unknown as GatewayManagementClient;
    const spawner = createMockSpawner(76543);
    const killer = createMockKiller(new Set([76543]));
    const probe = createMockProbe({ type: 'free' });

    const gp = new GatewaySupervisor(
      makeOptions(tmpDir, { makeGatewayClient: () => failingClient }),
      spawner,
      killer,
      probe,
    );

    await expect(gp.ensureRunning()).rejects.toThrow('Gateway failed to start within 10s');
    // Zombie cleanup: the spawned-but-unhealthy child is SIGKILL'd so
    // the next ensureRunning() can bind the port.
    expect(killer.signal).toHaveBeenCalledWith(76543, 'SIGKILL');
  }, 15_000);

  // ------------------------------------------------------------------
  // Concurrency guard
  // ------------------------------------------------------------------

  it('concurrent ensureRunning() calls share one spawn', async () => {
    const mockClient = createMockGatewayClient();
    const spawner = createMockSpawner();
    const probe = createMockProbe({ type: 'free' });

    const gp = new GatewaySupervisor(
      makeOptions(tmpDir, { makeGatewayClient: () => mockClient }),
      spawner,
      undefined,
      probe,
    );

    const [a, b, c] = await Promise.all([
      gp.ensureRunning(),
      gp.ensureRunning(),
      gp.ensureRunning(),
    ]);

    expect(spawner.spawn).toHaveBeenCalledTimes(1);
    expect(a).toBe(mockClient);
    expect(b).toBe(mockClient);
    expect(c).toBe(mockClient);
  });

  // ------------------------------------------------------------------
  // SIGKILL escalation
  // ------------------------------------------------------------------

  it('escalates SIGTERM to SIGKILL when stale process ignores SIGTERM', async () => {
    await writeState(55555, '2026-01-01T00:00:00Z', 'stale-token');

    const staleClient = {
      listAgents: vi.fn().mockRejectedValue(new GatewayHttpError(401, 'listAgents', 'Unauthorized')),
    } as unknown as GatewayManagementClient;
    const freshClient = createMockGatewayClient('2026-04-01T00:00:00Z');
    let call = 0;
    const makeGatewayClient = vi.fn(() => (call++ === 0 ? staleClient : freshClient));

    // Mock killer that ignores SIGTERM; only SIGKILL marks the pid as dead.
    const aliveSet = new Set([55555]);
    const killer: ProcessKiller & {
      signal: ReturnType<typeof vi.fn>;
      isAlive: ReturnType<typeof vi.fn>;
    } = {
      isAlive: vi.fn((pid: number) => aliveSet.has(pid)),
      signal: vi.fn((pid: number, sig: NodeJS.Signals) => {
        if (sig === 'SIGKILL') aliveSet.delete(pid);
      }),
    };

    const spawner = createMockSpawner(77777);
    const probe = createMockProbe(probeOwner('2026-01-01T00:00:00Z', 55555));

    const gp = new GatewaySupervisor(
      makeOptions(tmpDir, { makeGatewayClient }),
      spawner,
      killer,
      probe,
    );

    await gp.ensureRunning();

    expect(killer.signal).toHaveBeenCalledWith(55555, 'SIGTERM');
    expect(killer.signal).toHaveBeenCalledWith(55555, 'SIGKILL');
    expect(spawner.spawn).toHaveBeenCalledOnce();
  }, 15_000);
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
