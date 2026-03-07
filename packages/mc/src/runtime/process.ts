import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, statSync } from 'node:fs';
import { chmod, readFile, readdir, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AgentRegistry } from '../agents/registry.js';
import { generateToken } from '../security/keygen.js';
import type { SecretStore } from '../security/secrets.js';
import { type ProcessSnapshot, resolveRuntimeStatus } from './status.js';
import type { DeploymentRuntime, RuntimeStatus } from './types.js';

const LOG_BUFFER_MAX = 10_000;

class LogBuffer {
  private lines: string[] = [];
  private emitter = new EventEmitter();

  append(line: string): void {
    this.lines.push(line);
    if (this.lines.length > LOG_BUFFER_MAX) {
      this.lines.splice(0, this.lines.length - LOG_BUFFER_MAX);
    }
    this.emitter.emit('line', line);
  }

  async *follow(): AsyncIterable<string> {
    // Yield history
    for (const line of this.lines) {
      yield line;
    }
    // Follow new lines
    const queue: string[] = [];
    let resolve: (() => void) | null = null;

    const onLine = (line: string) => {
      queue.push(line);
      if (resolve) {
        resolve();
        resolve = null;
      }
    };

    this.emitter.on('line', onLine);
    try {
      while (true) {
        if (queue.length > 0) {
          yield queue.shift() as string;
        } else {
          await new Promise<void>((r) => {
            resolve = r;
          });
        }
      }
    } finally {
      this.emitter.off('line', onLine);
    }
  }
}

interface ProcessState {
  agentServer: SpawnedProcess;
  gateway: SpawnedProcess | null;
  logBuffer: LogBuffer;
  startTime: number;
}

export interface SpawnedProcess {
  pid?: number;
  exitCode: number | null;
  stdout: import('node:stream').Readable | null;
  stderr: import('node:stream').Readable | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  on(event: string, listener: (...args: unknown[]) => void): this;
}

export interface ProcessSpawner {
  spawn(
    command: string,
    args: string[],
    options: { env?: Record<string, string | undefined>; stdio?: unknown[] },
  ): SpawnedProcess;
}

const defaultSpawner: ProcessSpawner = {
  spawn: (command, args, options) =>
    spawn(command, args, options as Parameters<typeof spawn>[2]) as unknown as SpawnedProcess,
};

export async function findAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error('Failed to get port')));
      }
    });
    server.on('error', reject);
  });
}

export function validateConfigDir(configDir: string): void {
  if (!existsSync(configDir)) {
    throw new Error(`Config directory does not exist: ${configDir}`);
  }
  if (!statSync(configDir).isDirectory()) {
    throw new Error(`Config path is not a directory: ${configDir}`);
  }

  const agentsDir = join(configDir, 'agents');
  const dashJson = join(configDir, 'dash.json');
  if (!existsSync(agentsDir) && !existsSync(dashJson)) {
    throw new Error(`Config directory must contain agents/ directory or dash.json: ${configDir}`);
  }
}

export interface AgentSecretsFile {
  anthropicApiKey: string;
  managementToken: string;
  chatToken: string;
}

export interface GatewaySecretsFile {
  agents: Record<string, { token: string }>;
  channels: Record<string, { token?: string }>;
}

export async function writeSecretsFile(
  secrets: AgentSecretsFile | GatewaySecretsFile,
  prefix: string,
): Promise<string> {
  const filePath = join(tmpdir(), `${prefix}-${randomUUID()}.json`);
  await writeFile(filePath, JSON.stringify(secrets, null, 2), { mode: 0o600 });
  await chmod(filePath, 0o600);
  return filePath;
}

interface GatewayJsonConfig {
  channels?: Record<string, { adapter?: string; agent?: string; allowedUsers?: string[] }>;
}

export function buildGatewayConfig(
  agentNames: string[],
  chatPort: number,
  mcAdapterPort: number,
  gatewayJson?: GatewayJsonConfig,
): Record<string, unknown> {
  const agents: Record<string, { url: string; token: string }> = {};
  for (const name of agentNames) {
    agents[name] = {
      url: `ws://localhost:${chatPort}/ws`,
      token: 'PLACEHOLDER', // Replaced by secrets file
    };
  }

  const channels: Record<string, unknown> = {};

  if (gatewayJson?.channels) {
    for (const [name, ch] of Object.entries(gatewayJson.channels)) {
      if (ch.adapter === 'telegram') {
        channels[name] = {
          adapter: 'telegram',
          agent: ch.agent ?? agentNames[0],
          token: 'PLACEHOLDER',
          allowedUsers: ch.allowedUsers,
        };
      } else if (ch.adapter === 'mission-control') {
        channels[name] = {
          adapter: 'mission-control',
          agent: ch.agent ?? agentNames[0],
          port: mcAdapterPort,
        };
      }
    }
  }

  // Always add an MC adapter channel if none configured
  if (
    !Object.values(channels).some(
      (ch) => (ch as { adapter?: string }).adapter === 'mission-control',
    )
  ) {
    channels.mc = {
      adapter: 'mission-control',
      agent: agentNames[0],
      port: mcAdapterPort,
    };
  }

  return { agents, channels };
}

export class ProcessRuntime implements DeploymentRuntime {
  private processes = new Map<string, ProcessState>();

  constructor(
    private registry: AgentRegistry,
    private secrets: SecretStore,
    private projectRoot: string,
    private spawner: ProcessSpawner = defaultSpawner,
  ) {}

  async deploy(configDir: string): Promise<string> {
    const absConfigDir = resolve(configDir);
    validateConfigDir(absConfigDir);

    // Read agent configs from agents/ directory or dash.json
    interface AgentCfg {
      name: string;
      model: string;
      systemPrompt: string;
      tools?: string[];
    }
    const agentConfigs: Record<string, AgentCfg> = {};

    const agentsDir = join(absConfigDir, 'agents');
    if (existsSync(agentsDir) && statSync(agentsDir).isDirectory()) {
      const files = await readdir(agentsDir);
      for (const file of files.filter((f) => f.endsWith('.json'))) {
        const name = file.slice(0, -5);
        const raw = await readFile(join(agentsDir, file), 'utf-8');
        const cfg = JSON.parse(raw) as Partial<AgentCfg>;
        agentConfigs[name] = {
          name,
          model: cfg.model ?? '',
          systemPrompt: cfg.systemPrompt ?? '',
          tools: cfg.tools,
        };
      }
    }

    if (Object.keys(agentConfigs).length === 0) {
      // Fall back to dash.json agents
      const dashJsonPath = join(absConfigDir, 'dash.json');
      if (existsSync(dashJsonPath)) {
        const raw = await readFile(dashJsonPath, 'utf-8');
        const dashJson = JSON.parse(raw) as { agents?: Record<string, Partial<AgentCfg>> };
        if (dashJson.agents) {
          for (const [name, cfg] of Object.entries(dashJson.agents)) {
            agentConfigs[name] = {
              name,
              model: cfg.model ?? '',
              systemPrompt: cfg.systemPrompt ?? '',
              tools: cfg.tools,
            };
          }
        }
      }
    }

    const agentNames = Object.keys(agentConfigs);
    if (agentNames.length === 0) {
      throw new Error('No agent configurations found in config directory');
    }

    // Read gateway.json if present
    let gatewayJson: GatewayJsonConfig | undefined;
    const gatewayJsonPath = join(absConfigDir, 'gateway.json');
    if (existsSync(gatewayJsonPath)) {
      const raw = await readFile(gatewayJsonPath, 'utf-8');
      gatewayJson = JSON.parse(raw) as GatewayJsonConfig;
    }

    // Allocate ports
    const [managementPort, chatPort, mcAdapterPort] = await Promise.all([
      findAvailablePort(),
      findAvailablePort(),
      findAvailablePort(),
    ]);

    // Generate tokens
    const managementToken = generateToken();
    const chatToken = generateToken();
    const id = randomUUID().slice(0, 8);

    // Store tokens in secret store
    await this.secrets.set(`agent-token:${id}`, managementToken);
    await this.secrets.set(`chat-token:${id}`, chatToken);

    // Read Anthropic API key from secret store
    const anthropicApiKey = await this.secrets.get('anthropic-api-key');
    if (!anthropicApiKey) {
      throw new Error(
        'Missing anthropic-api-key in secret store. Run `mc deploy` to be prompted, or set it manually.',
      );
    }

    // Write temp agent-server secrets file
    const agentSecretsFile: AgentSecretsFile = {
      anthropicApiKey,
      managementToken,
      chatToken,
    };
    const agentSecretsPath = await writeSecretsFile(agentSecretsFile, 'agent-secrets');

    // Build gateway config
    const gatewayConfig = buildGatewayConfig(agentNames, chatPort, mcAdapterPort, gatewayJson);

    // Write temp gateway config
    const gatewayConfigPath = join(tmpdir(), `gw-config-${id}.json`);
    await writeFile(gatewayConfigPath, JSON.stringify(gatewayConfig, null, 2));

    // Build gateway secrets file
    const gwSecrets: GatewaySecretsFile = { agents: {}, channels: {} };
    for (const name of agentNames) {
      gwSecrets.agents[name] = { token: chatToken };
    }

    // Copy channel secrets (e.g. telegram bot token)
    if (gatewayJson?.channels) {
      for (const [name, ch] of Object.entries(gatewayJson.channels)) {
        if (ch.adapter === 'telegram') {
          const botToken = await this.secrets.get('telegram-bot-token');
          if (botToken) {
            gwSecrets.channels[name] = { token: botToken };
          }
        }
      }
    }

    const gwSecretsPath = await writeSecretsFile(gwSecrets, 'gw-secrets');

    // Spawn agent-server
    const agentServerBin = join(this.projectRoot, 'apps/dash/dist/index.js');
    const agentServer = this.spawner.spawn(
      'node',
      [agentServerBin, '--config', absConfigDir, '--secrets', agentSecretsPath],
      {
        env: {
          ...process.env,
          MANAGEMENT_API_PORT: String(managementPort),
          CHAT_API_PORT: String(chatPort),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    // Spawn gateway
    const gatewayBin = join(this.projectRoot, 'apps/gateway/dist/index.js');
    const gateway = this.spawner.spawn(
      'node',
      [gatewayBin, '--config', gatewayConfigPath, '--secrets', gwSecretsPath],
      {
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    // Set up log capture
    const logBuffer = new LogBuffer();

    // Handle spawn errors
    agentServer.on('error', (err) => {
      logBuffer.append(`[agent-server] Spawn error: ${err.message}`);
    });
    gateway.on('error', (err) => {
      logBuffer.append(`[gateway] Spawn error: ${err.message}`);
    });

    agentServer.stdout?.on('data', (data: Buffer) => {
      for (const line of data.toString().split('\n').filter(Boolean)) {
        logBuffer.append(`[agent-server] ${line}`);
      }
    });
    agentServer.stderr?.on('data', (data: Buffer) => {
      for (const line of data.toString().split('\n').filter(Boolean)) {
        logBuffer.append(`[agent-server] ${line}`);
      }
    });
    gateway.stdout?.on('data', (data: Buffer) => {
      for (const line of data.toString().split('\n').filter(Boolean)) {
        logBuffer.append(`[gateway] ${line}`);
      }
    });
    gateway.stderr?.on('data', (data: Buffer) => {
      for (const line of data.toString().split('\n').filter(Boolean)) {
        logBuffer.append(`[gateway] ${line}`);
      }
    });

    this.processes.set(id, {
      agentServer,
      gateway,
      logBuffer,
      startTime: Date.now(),
    });

    // Watch for process exit
    const updateOnExit = async (proc: string, code: number | null) => {
      logBuffer.append(`[${proc}] Process exited with code ${code}`);
      const state = this.processes.get(id);
      if (!state) return;

      // Check if both processes are dead
      const agentDead = state.agentServer.exitCode !== null;
      const gatewayDead = !state.gateway || state.gateway.exitCode !== null;
      if (agentDead && gatewayDead) {
        try {
          await this.registry.update(id, { status: 'stopped' });
        } catch {
          // Registry update can fail if already removed
        }
      }
    };

    agentServer.on('exit', (code) => updateOnExit('agent-server', code));
    gateway.on('exit', (code) => updateOnExit('gateway', code));

    // Register deployment
    const name = agentNames[0] ?? 'deployment';
    await this.registry.add({
      id,
      name,
      target: 'local',
      status: 'running',
      config: {
        target: 'local',
        agents: agentConfigs,
        channels: {},
      },
      createdAt: new Date().toISOString(),
      configDir: absConfigDir,
      agentServerPid: agentServer.pid,
      gatewayPid: gateway.pid,
      managementPort,
      managementToken,
      chatPort,
      chatToken,
    });

    return id;
  }

  async start(_id: string): Promise<void> {
    throw new Error('Re-starting stopped deployments is not yet supported. Use deploy instead.');
  }

  async stop(id: string): Promise<void> {
    const deployment = await this.registry.get(id);
    if (!deployment) {
      throw new Error(`Deployment "${id}" not found`);
    }

    const state = this.processes.get(id);
    if (state) {
      // Graceful shutdown: SIGTERM → wait 5s → SIGKILL
      const killProcess = (proc: SpawnedProcess, label: string): Promise<void> => {
        return new Promise((resolve) => {
          if (proc.exitCode !== null) {
            resolve();
            return;
          }

          const timeout = setTimeout(() => {
            proc.kill('SIGKILL');
          }, 5000);

          proc.on('exit', () => {
            clearTimeout(timeout);
            resolve();
          });

          state.logBuffer.append(`[${label}] Sending SIGTERM...`);
          proc.kill('SIGTERM');
        });
      };

      const kills: Promise<void>[] = [killProcess(state.agentServer, 'agent-server')];
      if (state.gateway) {
        kills.push(killProcess(state.gateway, 'gateway'));
      }
      await Promise.all(kills);
      this.processes.delete(id);
    } else {
      // Process not tracked in memory — try PID-based kill
      if (deployment.agentServerPid) {
        try {
          process.kill(deployment.agentServerPid, 'SIGTERM');
        } catch {
          // Process already dead
        }
      }
      if (deployment.gatewayPid) {
        try {
          process.kill(deployment.gatewayPid, 'SIGTERM');
        } catch {
          // Process already dead
        }
      }
    }

    await this.registry.update(id, { status: 'stopped' });
  }

  async remove(id: string): Promise<void> {
    const deployment = await this.registry.get(id);
    if (!deployment) {
      throw new Error(`Deployment "${id}" not found`);
    }

    // Stop if running
    if (deployment.status === 'running') {
      await this.stop(id);
    }

    // Clean up secrets
    await this.secrets.delete(`agent-token:${id}`);
    await this.secrets.delete(`chat-token:${id}`);

    // Remove from registry
    await this.registry.remove(id);
  }

  async getStatus(id: string): Promise<RuntimeStatus> {
    const deployment = await this.registry.get(id);
    if (!deployment) {
      throw new Error(`Deployment "${id}" not found`);
    }

    const state = this.processes.get(id);
    const snapshot: ProcessSnapshot | null = state
      ? {
          agentServer: {
            exitCode: state.agentServer.exitCode,
            pid: state.agentServer.pid,
          },
          gateway: state.gateway ? { pid: state.gateway.pid } : undefined,
          startTime: state.startTime,
        }
      : null;

    return resolveRuntimeStatus(snapshot, deployment);
  }

  async *getLogs(id: string): AsyncIterable<string> {
    const state = this.processes.get(id);
    if (!state) {
      throw new Error(
        `No active process for deployment "${id}". Logs are only available for the current session.`,
      );
    }
    yield* state.logBuffer.follow();
  }
}
