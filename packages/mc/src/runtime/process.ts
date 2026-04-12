import { spawn } from 'node:child_process';
import { closeSync, openSync, writeSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { generateToken } from '../security/keygen.js';
import { type GatewayHealthResponse, GatewayManagementClient } from './gateway-client.js';
import { type GatewayState, GatewayStateStore } from './gateway-state.js';

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
  constructor(
    private options: GatewaySupervisorOptions,
    private spawner: ProcessSpawner = defaultProcessSpawner,
    private killer: ProcessKiller = defaultProcessKiller,
  ) {}

  /**
   * Gracefully shut down a stale gateway process and wait for it to exit.
   * Used by both `restart()` and `ensureRunning()` when a tracked PID is
   * still alive but doesn't match our expected state (startedAt mismatch,
   * auth mismatch, or health check failure).
   *
   * The caller MUST have determined that the process is alive before
   * calling — this method assumes the PID is live at entry and waits
   * either until it dies or until the timeout elapses.
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
    // Wait up to 5s for exit.
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (!this.killer.isAlive(state.pid)) break;
      await new Promise<void>((r) => setTimeout(r, 300));
    }
    // Extra pause for the TCP port to fully release (macOS/Linux FIN_WAIT).
    await new Promise<void>((r) => setTimeout(r, 500));
  }

  async ensureRunning(): Promise<GatewayManagementClient> {
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
        try {
          const client = makeClient(`http://localhost:${state.port}`, state.token);
          const health = await client.health();
          if (health.startedAt === state.startedAt) {
            // Verify auth token still works (health is unauthenticated)
            await client.listAgents();
            return client;
          }
        } catch {
          /* health check or auth failed, fall through to reconcile */
        }

        // We got here with `pidAlive === true` but the process is not
        // the one we can use: either startedAt drifted (process was
        // restarted outside our control), the health endpoint is not
        // responding, or our token is wrong. In every case, the old
        // process is still holding the port — we MUST shut it down
        // before spawning a new one, otherwise the new spawn hits
        // EADDRINUSE and the caller ends up in a respawn loop.
        console.warn(
          `[gateway-supervisor] stale gateway PID ${state.pid} detected on port ${state.port}; shutting down before respawn`,
        );
        await this.shutdownStaleProcess(state);
      }

      // PID was dead OR we just killed it — clear the stale state file
      // so we don't read it back on the next `ensureRunning()` call if
      // the spawn below fails.
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
    if (!health) throw new Error('Gateway failed to start within 10s');

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
