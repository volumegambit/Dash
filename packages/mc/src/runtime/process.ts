import { execFile, spawn } from 'node:child_process';
import { closeSync, openSync, writeSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

/**
 * OS-level port-owner lookup via `lsof`. Used as a fallback when the
 * gateway's /health endpoint doesn't expose its own PID (older builds).
 * Returns the PID of the process listening on `port` on loopback, or
 * `undefined` if lsof isn't available, fails, or finds nothing.
 *
 * macOS/Linux only. On Windows this always returns undefined and the
 * caller must fall back to state.pid with a warning.
 */
async function lsofPortOwner(port: number): Promise<number | undefined> {
  if (process.platform === 'win32') return undefined;
  try {
    const { stdout } = await execFileP(
      'lsof',
      ['-nP', '-ti', `TCP@127.0.0.1:${port}`, '-sTCP:LISTEN'],
      { timeout: 2000 },
    );
    const line = stdout
      .trim()
      .split('\n')
      .find((l) => l.length > 0);
    if (!line) return undefined;
    const pid = Number.parseInt(line, 10);
    return Number.isFinite(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}
import { generateToken } from '../security/keygen.js';
import {
  type GatewayHealthResponse,
  GatewayHttpError,
  GatewayManagementClient,
} from './gateway-client.js';
import { type GatewayState, GatewayStateStore } from './gateway-state.js';

/**
 * Classify an error thrown by the reuse-check (health + startedAt + listAgents)
 * as either a transient blip (network timeout, 5xx, connection refused) or a
 * permanent mismatch (401 auth error) that requires reconciling with the
 * running process. Everything that is not a clear permanent failure is
 * treated as transient — we prefer to retry over to needlessly kill a
 * gateway that was about to recover.
 */
function isPermanentAuthMismatch(err: unknown): boolean {
  return err instanceof GatewayHttpError && err.status === 401;
}

export { providerSecretKey, parseProviderSecretKey } from './provider-keys.js';

// ---------------------------------------------------------------------------
// Process spawning interfaces (used by GatewaySupervisor and tests)
// ---------------------------------------------------------------------------

export interface SpawnedProcess {
  pid?: number;
  exitCode: number | null;
  stdout?: NodeJS.ReadableStream | null;
  stderr?: NodeJS.ReadableStream | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  on(event: string, listener: (...args: unknown[]) => void): this;
}

export interface ProcessSpawner {
  spawn(
    command: string,
    args: string[],
    options: {
      env?: Record<string, string | undefined>;
      stdio?: unknown[];
      detached?: boolean;
    },
  ): SpawnedProcess & { unref?: () => void };
}

/**
 * Process-signalling abstraction used for the "is this PID alive?" check
 * and for killing stale gateway processes. Injectable so tests don't have
 * to actually signal real processes (in particular, `process.pid` is
 * commonly used as a "guaranteed alive" PID in tests, and a real SIGTERM
 * to that PID would kill the test runner).
 */
export interface ProcessKiller {
  /** Returns true if the PID is alive, false if not. Mirrors `process.kill(pid, 0)`. */
  isAlive(pid: number): boolean;
  /** Send a signal. Throws if the PID is already gone. */
  signal(pid: number, sig: NodeJS.Signals): void;
}

export const defaultProcessKiller: ProcessKiller = {
  isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  },
  signal(pid: number, sig: NodeJS.Signals): void {
    process.kill(pid, sig);
  },
};

/**
 * Result of probing a TCP port for a gateway process. Three cases that
 * the supervisor handles very differently:
 *
 * - `free`: the port is definitively unused (TCP connection refused).
 *   Safe to spawn a fresh gateway immediately.
 *
 * - `owner`: there IS a gateway listening and it answered `/health`
 *   with a recognisable body. We can identify it (by `startedAt` and
 *   ideally `pid`) and decide whether to reuse it, kill it, or report
 *   auth mismatch.
 *
 * - `unknown`: something is on the port but we can't tell what —
 *   timeout, non-gateway process, gateway mid-startup, 5xx. CRUCIAL:
 *   the supervisor treats this as "do not touch" and propagates as a
 *   transient error. Acting on it (spawn or kill) risks the classic
 *   EADDRINUSE respawn loop, because a brief `/health` stutter is
 *   indistinguishable from "listener dead" at the probe layer.
 */
export type PortOwnerProbeResult =
  | { type: 'free' }
  | { type: 'owner'; startedAt: string; pid?: number }
  | { type: 'unknown'; reason: string };

/**
 * Injectable probe so tests can mock port ownership without actually
 * binding real sockets.
 */
export type PortOwnerProbe = (port: number) => Promise<PortOwnerProbeResult>;

export const defaultPortOwnerProbe: PortOwnerProbe = async (port) => {
  let res: Response;
  try {
    res = await fetch(`http://localhost:${port}/health`, {
      signal: AbortSignal.timeout(1500),
    });
  } catch (err) {
    // undici wraps network errors; ECONNREFUSED means nobody is
    // listening. Everything else (timeout, aborted, DNS, ...) means
    // *something* is there but unresponsive — treat as unknown.
    const cause = (err as { cause?: { code?: string } })?.cause;
    if (cause?.code === 'ECONNREFUSED') return { type: 'free' };
    return {
      type: 'unknown',
      reason: err instanceof Error ? err.message : String(err),
    };
  }
  if (!res.ok) {
    return { type: 'unknown', reason: `HTTP ${res.status}` };
  }
  let body: { startedAt?: string; pid?: number };
  try {
    body = (await res.json()) as { startedAt?: string; pid?: number };
  } catch (err) {
    return {
      type: 'unknown',
      reason: `non-JSON /health body: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (typeof body.startedAt !== 'string') {
    return { type: 'unknown', reason: 'missing startedAt in /health response' };
  }
  // Gateway identified. If /health didn't include pid (older gateway),
  // fall back to lsof so the supervisor always has a kill target.
  const pid = body.pid ?? (await lsofPortOwner(port));
  return { type: 'owner', startedAt: body.startedAt, pid };
};

export const defaultProcessSpawner: ProcessSpawner = {
  spawn: (command, args, options) =>
    spawn(command, args, options as Parameters<typeof spawn>[2]) as SpawnedProcess & {
      unref?: () => void;
    },
};

export type HealthChecker = (port: number) => Promise<boolean>;

export const defaultHealthChecker: HealthChecker = async (port: number): Promise<boolean> => {
  try {
    const resp = await fetch(`http://localhost:${port}/health`, {
      signal: AbortSignal.timeout(1000),
    });
    return resp.ok;
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------------------
// GatewaySupervisor
// ---------------------------------------------------------------------------

export interface GatewaySupervisorOptions {
  gatewayDataDir: string;
  gatewayRuntimeDir?: string; // --data-dir passed to the gateway process
  projectRoot: string;
  makeGatewayClient?: (baseUrl: string, token: string) => GatewayManagementClient;
  managementPort?: number;
  channelPort?: number;
}

export class GatewaySupervisor {
  /**
   * In-flight `ensureRunning()` call, if any. All concurrent callers share
   * the same promise so we never race two reconcile/spawn sequences — a
   * key source of token drift and duplicate-gateway bugs in the previous
   * implementation, where the poller and an IPC handler could both hit
   * the "stale PID" path at the same moment and each spawn a fresh
   * gateway with a different token.
   */
  private ensureRunningPromise: Promise<GatewayManagementClient> | null = null;

  constructor(
    private options: GatewaySupervisorOptions,
    private spawner: ProcessSpawner = defaultProcessSpawner,
    private killer: ProcessKiller = defaultProcessKiller,
    private portOwnerProbe: PortOwnerProbe = defaultPortOwnerProbe,
  ) {}

  /**
   * Gracefully shut down a stale gateway process and wait for it to exit.
   * Used by both `restart()` and `ensureRunning()` when a process on
   * port 9300 doesn't match our expected state (startedAt mismatch or
   * auth mismatch).
   *
   * `targetPid` MUST be the real process holding the port, NOT
   * `state.pid`. Callers are responsible for resolving the port owner
   * first — typically by reading `health.pid` from the running server.
   * This matters because state.json can drift (crashes, orphaned
   * detached children, PID reuse); killing `state.pid` when the actual
   * listener has a different PID would kill the wrong process and
   * still hit EADDRINUSE on the next spawn.
   *
   * Escalates SIGTERM → SIGKILL after 5s so we never return with the
   * old process still holding the port.
   */
  private async shutdownStaleProcess(targetPid: number, state: GatewayState): Promise<void> {
    // Attempt graceful shutdown via management API first. This will
    // fail silently if our token doesn't match the running gateway
    // (the common case that brings us here), which is why we still
    // fall through to SIGTERM.
    try {
      await fetch(`http://localhost:${state.port}/lifecycle/shutdown`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${state.token}` },
        signal: AbortSignal.timeout(2000),
      });
    } catch {
      /* API unreachable or token mismatch — SIGTERM below will handle it */
    }
    try {
      this.killer.signal(targetPid, 'SIGTERM');
    } catch {
      // Already dead between check and kill; nothing to do.
      return;
    }
    // Wait up to 5s for SIGTERM to take effect.
    const termDeadline = Date.now() + 5_000;
    while (Date.now() < termDeadline) {
      if (!this.killer.isAlive(targetPid)) break;
      await new Promise<void>((r) => setTimeout(r, 300));
    }
    // Escalate to SIGKILL if still alive. Gateway children that are
    // stuck in MCP subprocess teardown or a blocking syscall will
    // ignore SIGTERM; SIGKILL is the hammer that always wins.
    // Returning from this method with the old process still on the
    // port would cause the subsequent spawn to hit EADDRINUSE.
    if (this.killer.isAlive(targetPid)) {
      console.warn(
        `[gateway-supervisor] stale PID ${targetPid} ignored SIGTERM; escalating to SIGKILL`,
      );
      try {
        this.killer.signal(targetPid, 'SIGKILL');
      } catch {
        /* disappeared between checks */
      }
      // Short wait for the kernel to reap the process.
      const killDeadline = Date.now() + 2_000;
      while (Date.now() < killDeadline) {
        if (!this.killer.isAlive(targetPid)) break;
        await new Promise<void>((r) => setTimeout(r, 100));
      }
    }
    // Extra pause for the TCP port to fully release (macOS/Linux FIN_WAIT).
    await new Promise<void>((r) => setTimeout(r, 500));
  }

  async ensureRunning(): Promise<GatewayManagementClient> {
    // Concurrency guard: if another caller is already reconciling /
    // spawning, join their promise instead of racing. Without this,
    // the poller tick and an IPC handler could both see "stale PID"
    // at the same moment, both call shutdownStaleProcess on the same
    // PID, and both spawn a fresh gateway — the second one wins the
    // port, the first one loses, and state.token ends up out of sync
    // with the actual running process.
    if (this.ensureRunningPromise) return this.ensureRunningPromise;
    this.ensureRunningPromise = this.ensureRunningInner().finally(() => {
      this.ensureRunningPromise = null;
    });
    return this.ensureRunningPromise;
  }

  private async ensureRunningInner(): Promise<GatewayManagementClient> {
    const opts = this.options;
    const managementPort = opts.managementPort ?? 9300;
    const channelPort = opts.channelPort ?? 9200;
    const store = new GatewayStateStore(opts.gatewayDataDir);
    const makeClient =
      opts.makeGatewayClient ?? ((url, token) => new GatewayManagementClient(url, token));

    const state = await store.read();

    // Reconcile against reality BEFORE trusting state.json. The port
    // owner may be a completely different process from the one in
    // state — common causes: orphan gateway inherited by init after
    // a parent MC crashed, PID reuse after a reboot, or a previous
    // spawn that crashed before state.json was updated.
    const probe = await this.portOwnerProbe(managementPort);

    if (probe.type === 'unknown') {
      // Something is on the port but not responding in a way we can
      // identify. Could be a transient `/health` stutter (mid-MCP
      // call, GC pause), a non-gateway process, or a gateway mid
      // startup. DO NOT act — acting on `unknown` is how the old
      // code got into the respawn loop. Propagate so the poller
      // reports unhealthy and retries next tick.
      throw new Error(
        `Port ${managementPort} listener is unresponsive or not a gateway: ${probe.reason}`,
      );
    }

    if (probe.type === 'owner') {
      // Someone is on the port. The ONLY outcome of ensureRunning on a
      // held port is reuse — we never kill processes we don't
      // explicitly own. Reuse is gated on successful auth with our
      // saved token (cryptographic proof the gateway is the one we
      // spawned, since tokens are 256-bit random per spawn). Any
      // other outcome throws with an actionable message and lets the
      // operator decide what to do.
      if (!state) {
        // No recorded state but the port is occupied. This is either
        // an orphan from a previous MC that crashed, a gateway from
        // a different MC profile, or a manually-started gateway. We
        // can't tell which and we don't have authorization to kill
        // it. Fail loudly.
        const pidHint = probe.pid !== undefined ? ` PID ${probe.pid}` : '';
        throw new Error(
          `Port ${managementPort} is already in use by another gateway${pidHint} that we did not spawn. ` +
            `Stop it manually before starting MC: lsof -ti :${managementPort} | xargs kill`,
        );
      }
      // State exists — try to reuse with our token.
      try {
        const client = makeClient(`http://localhost:${state.port}`, state.token);
        await client.listAgents();
        // Happy path — every new MC launch / poller tick goes
        // through here as long as the gateway we spawned is still
        // up and still accepts our token. No spawn, no kill.
        return client;
      } catch (err) {
        if (!isPermanentAuthMismatch(err)) throw err; // transient — propagate
        // 401 — our token does not work. The gateway on the port is
        // somebody else's. We refuse to kill processes we don't
        // definitively own (was the root cause of MC nuking user
        // processes and orphaned gateways). Give the operator the
        // information they need to decide.
        const pidHint = probe.pid !== undefined ? ` PID ${probe.pid}` : '';
        throw new Error(
          `Port ${managementPort} is held by a gateway${pidHint} that does not accept our token. This is not the gateway MC spawned. Stop it manually and restart: lsof -ti :${managementPort} | xargs kill`,
        );
      }
    }

    // probe.type === 'free' — port is truly empty.
    if (state) {
      // Stale state pointing at a gateway that's no longer there.
      // Clear it so the spawn path writes a fresh record.
      await store.clear();
    }

    // Spawn fresh gateway daemon
    const token = generateToken();
    const chatToken = generateToken();
    const gatewayBin = join(opts.projectRoot, 'apps/gateway/dist/index.js');
    const spawnArgs = [
      gatewayBin,
      '--management-port',
      String(managementPort),
      '--channel-port',
      String(channelPort),
      '--token',
      token,
      '--chat-token',
      chatToken,
    ];
    if (opts.gatewayRuntimeDir) {
      spawnArgs.push('--data-dir', opts.gatewayRuntimeDir);
    }
    // Write gateway logs to a file so they can be viewed from MC
    const logsDir = join(opts.gatewayDataDir, 'logs');
    await mkdir(logsDir, { recursive: true });
    const logPath = join(logsDir, 'gateway.log');
    const logFd = openSync(logPath, 'a');
    writeSync(logFd, `\n--- Gateway starting at ${new Date().toISOString()} ---\n`);

    const gateway = this.spawner.spawn('node', spawnArgs, {
      env: { ...process.env },
      stdio: ['ignore', logFd, logFd],
      detached: true,
    });
    (gateway as { unref?: () => void }).unref?.();
    closeSync(logFd); // Child inherited the fd; parent can close its copy

    // Wait for health endpoint
    const newClient = makeClient(`http://localhost:${managementPort}`, token);
    const deadline = Date.now() + 10_000;
    let health: GatewayHealthResponse | null = null;
    while (Date.now() < deadline) {
      await new Promise<void>((r) => setTimeout(r, 300));
      try {
        health = await newClient.health();
        break;
      } catch {
        /* not ready yet */
      }
    }
    if (!health) {
      // Spawn failed to become healthy in time. The child may be a
      // zombie (hung on MCP startup, blocked on syscall, etc.) that is
      // still holding the port — kill it so the next ensureRunning()
      // can bind cleanly. SIGKILL rather than SIGTERM because we've
      // already waited 10s for graceful startup and don't want to
      // wait more.
      const gatewayPid = gateway.pid;
      if (gatewayPid && this.killer.isAlive(gatewayPid)) {
        try {
          this.killer.signal(gatewayPid, 'SIGKILL');
        } catch {
          /* already dead */
        }
      }
      throw new Error('Gateway failed to start within 10s');
    }

    const gatewayPid = gateway.pid;
    if (!gatewayPid) throw new Error('Gateway process has no PID');
    await store.write({
      pid: gatewayPid,
      startedAt: health.startedAt,
      token,
      port: managementPort,
      channelPort,
      chatToken,
    });

    return newClient;
  }

  /**
   * Kill the running gateway process and spawn a fresh one.
   * Returns a client connected to the new instance.
   */
  async restart(): Promise<GatewayManagementClient> {
    const store = new GatewayStateStore(this.options.gatewayDataDir);
    const state = await store.read();
    if (state) {
      // Prefer the authoritative port-owner PID over state.pid — same
      // reasoning as in ensureRunningInner(): state can drift. For
      // restart we don't care about `unknown` vs `free` distinctions
      // — we're going to kill and respawn regardless — but we do
      // want the right PID.
      const probe = await this.portOwnerProbe(state.port);
      const killPid = probe.type === 'owner' ? (probe.pid ?? state.pid) : state.pid;
      if (this.killer.isAlive(killPid)) {
        await this.shutdownStaleProcess(killPid, state);
      }
      await store.clear();
    }
    return this.ensureRunning();
  }

  async getClient(): Promise<GatewayManagementClient | null> {
    const store = new GatewayStateStore(this.options.gatewayDataDir);
    const state = await store.read();
    if (!state) return null;
    const makeClient =
      this.options.makeGatewayClient ?? ((url, token) => new GatewayManagementClient(url, token));
    return makeClient(`http://localhost:${state.port}`, state.token);
  }
}
