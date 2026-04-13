import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryKeychainStore } from '../security/keychain-store.js';
import { GatewayHttpError, type GatewayManagementClient } from './gateway-client.js';
import { GatewayStateStore } from './gateway-state.js';
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

  /**
   * Write a GatewayState file AND seed a fresh InMemoryKeychainStore
   * with a matching gateway + chat token. Returns both so tests can
   * assert against either the file or the keychain. Pass `token:
   * undefined` to leave the keychain empty (simulates keychain-wiped
   * edge cases).
   */
  async function setupRunningGateway(opts: {
    pid: number;
    startedAt: string;
    token?: string | undefined;
  }): Promise<{ store: GatewayStateStore; keychain: InMemoryKeychainStore }> {
    const store = new GatewayStateStore(tmpDir);
    await store.write({
      pid: opts.pid,
      startedAt: opts.startedAt,
      port: 9300,
      channelPort: 9200,
    });
    const keychain = new InMemoryKeychainStore();
    if (opts.token !== undefined) {
      await keychain.setGatewayToken(opts.token);
      await keychain.setChatToken('chat-tok');
    }
    return { store, keychain };
  }

  // ------------------------------------------------------------------
  // Clean spawn path: nothing on the port, no state
  // ------------------------------------------------------------------

  it('spawns gateway when no state exists and port is free', async () => {
    const mockClient = createMockGatewayClient();
    const spawner = createMockSpawner();
    const probe = createMockProbe({ type: 'free' });
    const keychain = new InMemoryKeychainStore();

    const gp = new GatewaySupervisor(
      makeOptions(tmpDir, { makeGatewayClient: () => mockClient }),
      spawner,
      undefined,
      probe,
      keychain,
    );

    const client = await gp.ensureRunning();

    expect(spawner.spawn).toHaveBeenCalledOnce();
    expect(spawner.spawn).toHaveBeenCalledWith(
      'node',
      expect.arrayContaining([expect.stringContaining('apps/gateway/dist/index.js')]),
      expect.objectContaining({ detached: true }),
    );
    expect(client).toBe(mockClient);
    // Clean spawn generates fresh keychain tokens — both gateway and
    // chat tokens must land in the keychain after ensureRunning().
    expect(await keychain.getGatewayToken()).toBeTruthy();
    expect(await keychain.getChatToken()).toBeTruthy();
  });

  it('passes --data-dir when gatewayRuntimeDir is set', async () => {
    const spawner = createMockSpawner();
    const probe = createMockProbe({ type: 'free' });
    const keychain = new InMemoryKeychainStore();

    const gp = new GatewaySupervisor(
      makeOptions(tmpDir, {
        makeGatewayClient: () => createMockGatewayClient(),
        gatewayRuntimeDir: '/custom/data/dir',
      }),
      spawner,
      undefined,
      probe,
      keychain,
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
    const { keychain } = await setupRunningGateway({
      pid: 12345,
      startedAt: '2026-01-01T00:00:00Z',
      token: 'existing-token',
    });

    const mockClient = createMockGatewayClient('2026-01-01T00:00:00Z');
    const spawner = createMockSpawner();
    const killer = createMockKiller(new Set([12345]));
    const probe = createMockProbe(probeOwner('2026-01-01T00:00:00Z', 12345));

    const gp = new GatewaySupervisor(
      makeOptions(tmpDir, { makeGatewayClient: () => mockClient }),
      spawner,
      killer,
      probe,
      keychain,
    );

    const client = await gp.ensureRunning();

    expect(spawner.spawn).not.toHaveBeenCalled();
    expect(killer.signal).not.toHaveBeenCalled();
    expect(client).toBe(mockClient);
    // Verify auth actually ran — the reuse decision must be based on
    // a real auth check, not optimistic state.json trust.
    expect(
      (mockClient as unknown as { listAgents: { mock: { calls: unknown[] } } }).listAgents.mock
        .calls.length,
    ).toBe(1);
  });

  it('reuses even when state.startedAt does not match probe.startedAt, as long as auth works', async () => {
    // Guard against over-eager respawn: if our token still works
    // (authoritative proof of identity), we should reuse even if
    // startedAt or pid in state.json have drifted for unrelated
    // reasons. Only a 401 should trigger a respawn.
    const { keychain } = await setupRunningGateway({
      pid: 12345,
      startedAt: '2026-01-01T00:00:00Z',
      token: 'still-valid-token',
    });

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
      keychain,
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
    const { keychain } = await setupRunningGateway({
      pid: 999999999,
      startedAt: '2026-01-01T00:00:00Z',
      token: 'old-token',
    });

    const mockClient = createMockGatewayClient('2026-02-01T00:00:00Z');
    const spawner = createMockSpawner(54321);
    const probe = createMockProbe({ type: 'free' });

    const gp = new GatewaySupervisor(
      makeOptions(tmpDir, { makeGatewayClient: () => mockClient }),
      spawner,
      undefined,
      probe,
      keychain,
    );

    await gp.ensureRunning();

    expect(spawner.spawn).toHaveBeenCalledOnce();
    // Critical: the existing keychain token is reused for the new
    // spawn rather than regenerated. Token stability across spawns
    // is the whole reason the supervisor reads from keychain first.
    expect(await keychain.getGatewayToken()).toBe('old-token');
    // Verify the spawn call used the same token.
    const spawnArgs = (spawner.spawn as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0][1] as string[];
    const tokenFlagIdx = spawnArgs.indexOf('--token');
    expect(spawnArgs[tokenFlagIdx + 1]).toBe('old-token');
  });

  // ------------------------------------------------------------------
  // Fail-loud paths: ensureRunning NEVER kills processes it didn't
  // spawn. When the port is held by something we can't reuse, throw
  // with an actionable message and let the operator decide.
  // ------------------------------------------------------------------

  it('throws when our token is rejected by the gateway on the port', async () => {
    // state.json exists but the gateway on the port has a different
    // token (orphan from a previous session, another MC profile,
    // manually-started gateway). The supervisor MUST NOT kill it —
    // killing processes MC didn't spawn is exactly the "creepy desktop
    // app" behaviour we removed.
    const { keychain } = await setupRunningGateway({
      pid: 11111,
      startedAt: '2026-01-01T00:00:00Z',
      token: 'stale-token',
    });

    const staleClient = {
      listAgents: vi
        .fn()
        .mockRejectedValue(new GatewayHttpError(401, 'listAgents', 'Unauthorized')),
    } as unknown as GatewayManagementClient;

    const spawner = createMockSpawner();
    const killer = createMockKiller(new Set([11111, 99785]));
    const probe = createMockProbe(probeOwner('2026-03-01T00:00:00Z', 99785));

    const gp = new GatewaySupervisor(
      makeOptions(tmpDir, { makeGatewayClient: () => staleClient }),
      spawner,
      killer,
      probe,
      keychain,
    );

    await expect(gp.ensureRunning()).rejects.toThrow(/does not accept our token/);
    // Nothing killed, nothing spawned. Operator must clean up.
    expect(killer.signal).not.toHaveBeenCalled();
    expect(spawner.spawn).not.toHaveBeenCalled();
  });

  it('error message mentions the port owner PID and the lsof command', async () => {
    const { keychain } = await setupRunningGateway({
      pid: 11111,
      startedAt: '2026-01-01T00:00:00Z',
      token: 'stale-token',
    });

    const staleClient = {
      listAgents: vi
        .fn()
        .mockRejectedValue(new GatewayHttpError(401, 'listAgents', 'Unauthorized')),
    } as unknown as GatewayManagementClient;

    const probe = createMockProbe(probeOwner('2026-03-01T00:00:00Z', 99785));

    const gp = new GatewaySupervisor(
      makeOptions(tmpDir, { makeGatewayClient: () => staleClient }),
      createMockSpawner(),
      createMockKiller(new Set([99785])),
      probe,
      keychain,
    );

    await expect(gp.ensureRunning()).rejects.toThrow(/PID 99785/);
    await expect(gp.ensureRunning()).rejects.toThrow(/lsof -ti :9300/);
  });

  it('throws when no state exists and the port is occupied by a foreign gateway', async () => {
    // Fresh MC install / cleared state, but there's an orphan gateway
    // on port 9300 (inherited by init from an earlier process, or
    // another user running MC concurrently). We have no token to
    // authenticate against, so we can't reuse. But we also must NOT
    // kill — we don't know who it belongs to.
    const spawner = createMockSpawner();
    const killer = createMockKiller(new Set([88888]));
    const probe = createMockProbe(probeOwner('2026-01-01T00:00:00Z', 88888));
    const keychain = new InMemoryKeychainStore();

    const gp = new GatewaySupervisor(
      makeOptions(tmpDir, {
        makeGatewayClient: () => createMockGatewayClient('2026-04-01T00:00:00Z'),
      }),
      spawner,
      killer,
      probe,
      keychain,
    );

    await expect(gp.ensureRunning()).rejects.toThrow(/already in use by another gateway/);
    expect(killer.signal).not.toHaveBeenCalled();
    expect(spawner.spawn).not.toHaveBeenCalled();
  });

  it('throws when state exists but keychain is empty and the port is held', async () => {
    // Keychain was wiped (e.g. OS login changed, user reset keychain)
    // but state.json survived. We can't authenticate against the
    // running gateway because we don't have its token, and we don't
    // own it enough to kill it. Fail loud — same recovery as any
    // other foreign-gateway case.
    const { keychain } = await setupRunningGateway({
      pid: 12345,
      startedAt: '2026-01-01T00:00:00Z',
      token: undefined, // Keychain deliberately left empty
    });

    const mockClient = createMockGatewayClient();
    const spawner = createMockSpawner();
    const killer = createMockKiller(new Set([12345]));
    const probe = createMockProbe(probeOwner('2026-01-01T00:00:00Z', 12345));

    const gp = new GatewaySupervisor(
      makeOptions(tmpDir, { makeGatewayClient: () => mockClient }),
      spawner,
      killer,
      probe,
      keychain,
    );

    await expect(gp.ensureRunning()).rejects.toThrow(/already in use by another gateway/);
    expect(spawner.spawn).not.toHaveBeenCalled();
    expect(killer.signal).not.toHaveBeenCalled();
  });

  // ------------------------------------------------------------------
  // Transient-failure path: probe returns `unknown`
  // ------------------------------------------------------------------

  it('propagates unknown probe result WITHOUT killing or respawning', async () => {
    // Probe returns `unknown` when the listener is unresponsive:
    // timeout, non-JSON, missing startedAt, 5xx. Crucial that we do
    // NOT spawn or kill — acting on `unknown` is how the respawn
    // loop started in the first place.
    const { store, keychain } = await setupRunningGateway({
      pid: 33333,
      startedAt: '2026-01-01T00:00:00Z',
      token: 'tok',
    });

    const mockClient = createMockGatewayClient('2026-01-01T00:00:00Z');
    const spawner = createMockSpawner();
    const killer = createMockKiller(new Set([33333]));
    const probe = createMockProbe({ type: 'unknown', reason: '/health timeout' });

    const gp = new GatewaySupervisor(
      makeOptions(tmpDir, { makeGatewayClient: () => mockClient }),
      spawner,
      killer,
      probe,
      keychain,
    );

    await expect(gp.ensureRunning()).rejects.toThrow(/unresponsive/);

    expect(killer.signal).not.toHaveBeenCalled();
    expect(spawner.spawn).not.toHaveBeenCalled();
    // State is preserved — next call can reuse if the blip clears.
    const stateAfter = await store.read();
    expect(stateAfter?.pid).toBe(33333);
  });

  it('propagates transient listAgents() 503 WITHOUT killing or respawning', async () => {
    const { keychain } = await setupRunningGateway({
      pid: 44444,
      startedAt: '2026-01-01T00:00:00Z',
      token: 'existing-token',
    });

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
      keychain,
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
    const keychain = new InMemoryKeychainStore();

    const gp = new GatewaySupervisor(
      makeOptions(tmpDir, { makeGatewayClient: () => failingClient }),
      spawner,
      killer,
      probe,
      keychain,
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
    const keychain = new InMemoryKeychainStore();

    const gp = new GatewaySupervisor(
      makeOptions(tmpDir, { makeGatewayClient: () => mockClient }),
      spawner,
      undefined,
      probe,
      keychain,
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
});

// ---------------------------------------------------------------------------
// GatewaySupervisor.restart() — the only legitimate kill path
// ---------------------------------------------------------------------------

describe('GatewaySupervisor.restart()', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'gw-restart-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true });
  });

  it('gracefully shuts down our gateway and spawns a fresh one', async () => {
    // User explicitly clicked "Restart Gateway" — MC owns the gateway
    // (it has the token), so killing is authorized.
    const store = new GatewayStateStore(tmpDir);
    await store.write({
      pid: 55555,
      startedAt: '2026-01-01T00:00:00Z',
      port: 9300,
      channelPort: 9200,
    });
    const keychain = new InMemoryKeychainStore();
    await keychain.setGatewayToken('our-token');
    await keychain.setChatToken('chat-tok');

    const spawner = createMockSpawner(77777);
    const killer = createMockKiller(new Set([55555]));
    // First probe (called from restart to find kill target) returns
    // the live gateway; second probe (called from ensureRunning
    // after store.clear()) returns free because the mock killer
    // deleted the pid.
    let probeCall = 0;
    const probe = vi.fn(async (): Promise<PortOwnerProbeResult> => {
      probeCall++;
      if (probeCall === 1) return probeOwner('2026-01-01T00:00:00Z', 55555);
      return { type: 'free' };
    }) as PortOwnerProbe & ReturnType<typeof vi.fn>;

    const gp = new GatewaySupervisor(
      makeOptions(tmpDir, { makeGatewayClient: () => createMockGatewayClient() }),
      spawner,
      killer,
      probe,
      keychain,
    );

    await gp.restart();

    expect(killer.signal).toHaveBeenCalledWith(55555, 'SIGTERM');
    expect(spawner.spawn).toHaveBeenCalledOnce();
    // Token stability: the fresh spawn reused the same keychain token
    // rather than generating a new one. Agents don't lose identity
    // across an explicit restart.
    expect(await keychain.getGatewayToken()).toBe('our-token');
  });

  it('escalates SIGTERM to SIGKILL when the gateway ignores SIGTERM', async () => {
    const store = new GatewayStateStore(tmpDir);
    await store.write({
      pid: 66666,
      startedAt: '2026-01-01T00:00:00Z',
      port: 9300,
      channelPort: 9200,
    });
    const keychain = new InMemoryKeychainStore();
    await keychain.setGatewayToken('our-token');
    await keychain.setChatToken('chat-tok');

    const aliveSet = new Set([66666]);
    const killer: ProcessKiller & {
      signal: ReturnType<typeof vi.fn>;
      isAlive: ReturnType<typeof vi.fn>;
    } = {
      isAlive: vi.fn((pid: number) => aliveSet.has(pid)),
      signal: vi.fn((pid: number, sig: NodeJS.Signals) => {
        // SIGTERM is ignored (simulates process stuck in MCP teardown).
        // Only SIGKILL actually removes the pid.
        if (sig === 'SIGKILL') aliveSet.delete(pid);
      }),
    };

    let probeCall = 0;
    const probe = vi.fn(async (): Promise<PortOwnerProbeResult> => {
      probeCall++;
      if (probeCall === 1) return probeOwner('2026-01-01T00:00:00Z', 66666);
      return { type: 'free' };
    }) as PortOwnerProbe & ReturnType<typeof vi.fn>;

    const gp = new GatewaySupervisor(
      makeOptions(tmpDir, { makeGatewayClient: () => createMockGatewayClient() }),
      createMockSpawner(88888),
      killer,
      probe,
      keychain,
    );

    await gp.restart();

    expect(killer.signal).toHaveBeenCalledWith(66666, 'SIGTERM');
    expect(killer.signal).toHaveBeenCalledWith(66666, 'SIGKILL');
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
    const keychain = new InMemoryKeychainStore();
    const gp = new GatewaySupervisor(
      makeOptions(tmpDir),
      undefined,
      undefined,
      undefined,
      keychain,
    );
    const client = await gp.getClient();
    expect(client).toBeNull();
  });

  it('returns null when state exists but keychain token is missing', async () => {
    const store = new GatewayStateStore(tmpDir);
    await store.write({
      pid: process.pid,
      startedAt: '2026-01-01T00:00:00Z',
      port: 9300,
      channelPort: 9200,
    });
    // Empty keychain — can't build a working client.
    const keychain = new InMemoryKeychainStore();

    const gp = new GatewaySupervisor(
      makeOptions(tmpDir, { makeGatewayClient: () => createMockGatewayClient() }),
      undefined,
      undefined,
      undefined,
      keychain,
    );
    expect(await gp.getClient()).toBeNull();
  });

  it('returns client when state and keychain token both exist', async () => {
    const store = new GatewayStateStore(tmpDir);
    await store.write({
      pid: process.pid,
      startedAt: '2026-01-01T00:00:00Z',
      port: 9300,
      channelPort: 9200,
    });
    const keychain = new InMemoryKeychainStore();
    await keychain.setGatewayToken('gw-tok');
    await keychain.setChatToken('chat-tok');

    const mockClient = createMockGatewayClient();
    const gp = new GatewaySupervisor(
      makeOptions(tmpDir, { makeGatewayClient: () => mockClient }),
      undefined,
      undefined,
      undefined,
      keychain,
    );

    const client = await gp.getClient();
    expect(client).toBe(mockClient);
  });

  it('constructs client with correct base URL from state port and keychain token', async () => {
    const store = new GatewayStateStore(tmpDir);
    await store.write({
      pid: process.pid,
      startedAt: '2026-01-01T00:00:00Z',
      port: 9400,
      channelPort: 9500,
    });
    const keychain = new InMemoryKeychainStore();
    await keychain.setGatewayToken('my-token');

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
      undefined,
      undefined,
      undefined,
      keychain,
    );

    await gp.getClient();
    expect(capturedUrl).toBe('http://localhost:9400');
    expect(capturedToken).toBe('my-token');
  });
});
