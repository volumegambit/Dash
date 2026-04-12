import { spawn } from 'node:child_process';
import { closeSync, openSync, writeSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
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
  ) {}

  /**
   * Gracefully shut down a stale gateway process and wait for it to exit.
   * Used by both `restart()` and `ensureRunning()` when a tracked PID is
   * still alive but doesn't match our expected state (startedAt mismatch
   * or auth mismatch).
   *
   * The caller MUST have determined that the process is alive AND that
   * it is the wrong gateway before calling — this method always sends a
   * signal to `state.pid`. Escalates SIGTERM → SIGKILL after 5s so we
   * never return with the old process still holding the port.
   */
  private async shutdownStaleProcess(state: GatewayState): Promise<void> {
    // Attempt graceful shutdown via management API first. This will fail
    // silently if our token doesn't match the running gateway (the
    // common case that brings us here), which is why we still fall
    // through to SIGTERM.
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
      this.killer.signal(state.pid, 'SIGTERM');
    } catch {
      // Already dead between check and kill; nothing to do.
      return;
    }
    // Wait up to 5s for SIGTERM to take effect.
    const termDeadline = Date.now() + 5_000;
    while (Date.now() < termDeadline) {
      if (!this.killer.isAlive(state.pid)) break;
      await new Promise<void>((r) => setTimeout(r, 300));
    }
    // Escalate to SIGKILL if still alive. Gateway children that are
    // stuck in MCP subprocess teardown or a blocking syscall will ignore
    // SIGTERM; SIGKILL is the hammer that always wins. Returning from
    // this method with the old process still on the port would cause
    // the subsequent spawn to hit EADDRINUSE.
    if (this.killer.isAlive(state.pid)) {
      console.warn(
        `[gateway-supervisor] stale PID ${state.pid} ignored SIGTERM; escalating to SIGKILL`,
      );
      try {
        this.killer.signal(state.pid, 'SIGKILL');
      } catch {
        /* disappeared between checks */
      }
      // Short wait for the kernel to reap the process.
      const killDeadline = Date.now() + 2_000;
      while (Date.now() < killDeadline) {
        if (!this.killer.isAlive(state.pid)) break;
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

    if (state) {
      const pidAlive = this.killer.isAlive(state.pid);

      if (pidAlive) {
        // Classify: does the running process match our state (reuse) or
        // is it definitively the wrong gateway (kill + respawn) or are
        // we just seeing a transient error (propagate, caller retries).
        let permanentMismatch = false;
        try {
          const client = makeClient(`http://localhost:${state.port}`, state.token);
          const health = await client.health();
          if (health.startedAt !== state.startedAt) {
            // Gateway was restarted outside our control — definitive
            // mismatch, process is no longer "our" gateway.
            permanentMismatch = true;
          } else {
            // Verify the auth token still works. Any HTTP 401 here is
            // a permanent mismatch; any other error (timeout, 5xx,
            // connection refused) is transient and should NOT trigger
            // a respawn — the gateway was probably mid-MCP-call or
            // garbage-collecting and will be fine in a moment.
            try {
              await client.listAgents();
              return client;
            } catch (err) {
              if (isPermanentAuthMismatch(err)) {
                permanentMismatch = true;
              } else {
                throw err; // transient — let the caller decide
              }
            }
          }
        } catch (err) {
          // `health()` failure OR a transient `listAgents` failure
          // rethrown above. Neither is grounds for killing the
          // existing process. Propagate so the caller (typically the
          // poller) can report unhealthy and try again next tick
          // without leaking or restarting gateways.
          if (!permanentMismatch) throw err;
        }

        if (permanentMismatch) {
          console.warn(
            `[gateway-supervisor] stale gateway PID ${state.pid} on port ${state.port} (auth mismatch or startedAt drift); shutting down before respawn`,
          );
          await this.shutdownStaleProcess(state);
          await store.clear();
          // fall through to spawn
        }
      } else {
        // PID was dead — clear the stale state and spawn fresh below.
        await store.clear();
      }
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
    if (state && this.killer.isAlive(state.pid)) {
      await this.shutdownStaleProcess(state);
    }
    if (state) await store.clear();
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
