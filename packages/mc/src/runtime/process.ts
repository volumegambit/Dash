import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { generateToken } from '../security/keygen.js';
import { type GatewayHealthResponse, GatewayManagementClient } from './gateway-client.js';
import { GatewayStateStore } from './gateway-state.js';

export { providerSecretKey, parseProviderSecretKey } from './provider-keys.js';

// ---------------------------------------------------------------------------
// Process spawning interfaces (used by GatewayProcess and tests)
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
// GatewayProcess
// ---------------------------------------------------------------------------

export interface GatewayProcessOptions {
  gatewayDataDir: string;
  gatewayRuntimeDir?: string; // --data-dir passed to the gateway process
  projectRoot: string;
  makeGatewayClient?: (baseUrl: string, token: string) => GatewayManagementClient;
  managementPort?: number;
  channelPort?: number;
}

export class GatewayProcess {
  constructor(
    private options: GatewayProcessOptions,
    private spawner: ProcessSpawner = defaultProcessSpawner,
  ) {}

  async ensureRunning(): Promise<GatewayManagementClient> {
    const opts = this.options;
    const managementPort = opts.managementPort ?? 9300;
    const channelPort = opts.channelPort ?? 9200;
    const store = new GatewayStateStore(opts.gatewayDataDir);
    const makeClient =
      opts.makeGatewayClient ?? ((url, token) => new GatewayManagementClient(url, token));

    const state = await store.read();

    if (state) {
      // Check if PID is alive
      let pidAlive = false;
      try {
        process.kill(state.pid, 0);
        pidAlive = true;
      } catch {
        /* dead */
      }

      if (pidAlive) {
        try {
          const client = makeClient(`http://localhost:${state.port}`, state.token);
          const health = await client.health();
          if (health.startedAt === state.startedAt) {
            return client; // healthy and same instance
          }
        } catch {
          /* health check failed, fall through to spawn */
        }
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
    const logStream = createWriteStream(logPath, { flags: 'a' });
    logStream.write(`\n--- Gateway starting at ${new Date().toISOString()} ---\n`);

    const gateway = this.spawner.spawn('node', spawnArgs, {
      env: { ...process.env },
      stdio: ['ignore', logStream, logStream],
      detached: true,
    });
    (gateway as { unref?: () => void }).unref?.();
    logStream.unref();

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
    if (state) {
      // Try graceful shutdown via API first, fall back to SIGTERM
      try {
        const client = (this.options.makeGatewayClient ?? ((url, token) => new GatewayManagementClient(url, token)))(
          `http://localhost:${state.port}`,
          state.token,
        );
        await fetch(`http://localhost:${state.port}/lifecycle/shutdown`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${state.token}` },
          signal: AbortSignal.timeout(2000),
        }).catch(() => {});
      } catch {
        // API not reachable
      }
      try {
        process.kill(state.pid, 'SIGTERM');
      } catch {
        // Already dead
      }
      // Wait for process to exit (up to 5 seconds)
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        try {
          process.kill(state.pid, 0);
          await new Promise<void>((r) => setTimeout(r, 300));
        } catch {
          break; // Process is gone
        }
      }
      await store.clear();
      // Extra wait for port release
      await new Promise<void>((r) => setTimeout(r, 500));
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
