import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { chmod, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AgentRegistry } from '../agents/registry.js';
import type { MessagingAppRegistry } from '../messaging-apps/registry.js';
import { generateToken } from '../security/keygen.js';
import type { SecretStore } from '../security/secrets.js';
import type { MessagingApp } from '../types.js';
import { type ProcessSnapshot, resolveRuntimeStatus } from './status.js';
import type { DeploymentRuntime, RuntimeStatus } from './types.js';

interface ProcessState {
  agentServer: SpawnedProcess;
  gateway: SpawnedProcess | null;
  startTime: number;
}

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

export type StartupResult =
  | { success: true }
  | { success: false; logs: string[]; reason: string };

export const defaultHealthChecker: HealthChecker = async (port: number): Promise<boolean> => {
  try {
    const resp = await fetch(`http://localhost:${port}/health`, { signal: AbortSignal.timeout(1000) });
    return resp.ok;
  } catch {
    return false;
  }
};

export async function waitForStartup(
  child: SpawnedProcess,
  managementPort: number,
  timeoutMs: number,
  healthChecker: HealthChecker = defaultHealthChecker,
): Promise<StartupResult> {
  const logs: string[] = [];
  let readyLineSeen = false;
  let healthOk = false;
  let settled = false;

  return new Promise<StartupResult>((resolve) => {
    const settle = (result: StartupResult): void => {
      if (settled) return;
      settled = true;
      clearInterval(healthInterval);
      clearTimeout(timeoutHandle);
      resolve(result);
    };

    const checkSuccess = (): void => {
      if (readyLineSeen && healthOk) {
        settle({ success: true });
      }
    };

    // Capture log lines
    const onData = (chunk: Buffer | string): void => {
      const text = chunk.toString();
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        logs.push(trimmed);
        if (trimmed.includes('Server ready')) {
          readyLineSeen = true;
          checkSuccess();
        }
      }
    };

    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);

    // Watch for process exit
    child.on('exit', (code) => {
      settle({
        success: false,
        logs,
        reason: `process exited with code ${code ?? 'null'}`,
      });
    });

    // Poll health endpoint
    const healthInterval = setInterval(async () => {
      if (settled) return;
      try {
        healthOk = await healthChecker(managementPort);
        checkSuccess();
      } catch {
        // ignore
      }
    }, 500);

    // Timeout
    const timeoutHandle = setTimeout(() => {
      settle({ success: false, logs, reason: `timeout after ${timeoutMs}ms` });
    }, timeoutMs);
  });
}

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
  providerApiKeys?: Record<string, string>;
  managementToken: string;
  chatToken: string;
}

export interface GatewaySecretsFile {
  agents: Record<string, { token: string }>;
  channels: Record<string, { token?: string }>;
}

export interface ResolvedMessagingApp {
  app: MessagingApp;
  token: string;
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
  resolvedApps: ResolvedMessagingApp[] = [],
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

  // Inject enabled messaging apps targeting any of our agents
  for (const { app, token } of resolvedApps) {
    if (!app.enabled) continue;
    const relevantRules = app.routing.filter((r) => agentNames.includes(r.targetAgentName));
    if (relevantRules.length === 0) continue;

    channels[`messaging-app-${app.id}`] = {
      adapter: app.type,
      token,
      globalDenyList: app.globalDenyList,
      routing: relevantRules.map((r) => ({
        condition: r.condition,
        agentName: r.targetAgentName,
        allowList: r.allowList,
        denyList: r.denyList,
      })),
    };
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

async function killPidWithEscalation(pid: number): Promise<void> {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return; // Process already dead
  }

  // Poll for up to 5 seconds, then escalate to SIGKILL
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    try {
      process.kill(pid, 0); // throws ESRCH if process is dead
    } catch {
      return; // Process has exited
    }
  }

  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Process died just before SIGKILL
  }
}

export class ProcessRuntime implements DeploymentRuntime {
  private processes = new Map<string, ProcessState>();

  constructor(
    private registry: AgentRegistry,
    private secrets: SecretStore,
    private projectRoot: string,
    private spawner: ProcessSpawner = defaultProcessSpawner,
    private messagingApps?: MessagingAppRegistry,
  ) {}

  async deploy(configDir: string): Promise<string> {
    const absConfigDir = resolve(configDir);
    validateConfigDir(absConfigDir);

    // Read agent configs from agents/ directory or dash.json
    interface AgentCfg {
      name: string;
      model: string;
      fallbackModels?: string[];
      systemPrompt: string;
      tools?: string[];
      workspace?: string;
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
          fallbackModels: cfg.fallbackModels,
          systemPrompt: cfg.systemPrompt ?? '',
          tools: cfg.tools,
          workspace: cfg.workspace,
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
              fallbackModels: cfg.fallbackModels,
              systemPrompt: cfg.systemPrompt ?? '',
              tools: cfg.tools,
              workspace: cfg.workspace,
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

    // Resolve workspace for each agent: use config value or auto-generate
    for (const [name, cfg] of Object.entries(agentConfigs)) {
      if (!cfg.workspace) {
        cfg.workspace = join(homedir(), '.mission-control', 'workspaces', `${name}-${id}`);
      }
      await mkdir(cfg.workspace, { recursive: true, mode: 0o700 });
    }

    // Store tokens in secret store
    await this.secrets.set(`agent-token:${id}`, managementToken);
    await this.secrets.set(`chat-token:${id}`, chatToken);

    // Read provider API keys from secret store
    const anthropicApiKey = (await this.secrets.get('anthropic-api-key')) ?? undefined;
    const googleApiKey = (await this.secrets.get('google-api-key')) ?? undefined;
    const openaiApiKey = (await this.secrets.get('openai-api-key')) ?? undefined;

    if (!anthropicApiKey && !googleApiKey && !openaiApiKey) {
      throw new Error(
        'No provider API key configured. Add at least one API key in Mission Control Settings.',
      );
    }

    // Build providerApiKeys object for the agent config
    const providerApiKeys: Record<string, string> = {};
    if (anthropicApiKey) providerApiKeys['anthropic'] = anthropicApiKey;
    if (googleApiKey) providerApiKeys['google'] = googleApiKey;
    if (openaiApiKey) providerApiKeys['openai'] = openaiApiKey;

    // Write temp agent-server secrets file
    const agentSecretsFile: AgentSecretsFile = {
      providerApiKeys,
      managementToken,
      chatToken,
    };
    const agentSecretsPath = await writeSecretsFile(agentSecretsFile, 'agent-secrets');

    // Resolve messaging apps targeting any of our agents
    const resolvedApps: ResolvedMessagingApp[] = [];
    if (this.messagingApps) {
      const apps = await this.messagingApps.list();
      for (const app of apps) {
        if (!app.enabled) continue;
        const hasRelevantRule = app.routing.some((r) => agentNames.includes(r.targetAgentName));
        if (!hasRelevantRule) continue;
        const token = await this.secrets.get(app.credentialsKey);
        if (token) {
          resolvedApps.push({ app, token });
        }
      }
    }

    // Build gateway config
    const gatewayConfig = buildGatewayConfig(agentNames, chatPort, mcAdapterPort, gatewayJson, resolvedApps);

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
        stdio: ['ignore', 'ignore', 'ignore'],
        detached: true,
      },
    );
    (agentServer as { unref?: () => void }).unref?.();

    // Spawn gateway
    const gatewayBin = join(this.projectRoot, 'apps/gateway/dist/index.js');
    const gateway = this.spawner.spawn(
      'node',
      [gatewayBin, '--config', gatewayConfigPath, '--secrets', gwSecretsPath],
      {
        env: { ...process.env },
        stdio: ['ignore', 'ignore', 'ignore'],
        detached: true,
      },
    );
    (gateway as { unref?: () => void }).unref?.();

    this.processes.set(id, {
      agentServer,
      gateway,
      startTime: Date.now(),
    });

    // Watch for process exit
    const updateOnExit = async (_proc: string, _code: number | null) => {
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
      workspace: agentConfigs[agentNames[0]]?.workspace,
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
      const killProcess = (proc: SpawnedProcess): Promise<void> => {
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

          proc.kill('SIGTERM');
        });
      };

      const kills: Promise<void>[] = [killProcess(state.agentServer)];
      if (state.gateway) {
        kills.push(killProcess(state.gateway));
      }
      await Promise.all(kills);
      this.processes.delete(id);
    } else {
      // Process not tracked in memory — PID-based kill with SIGTERM → SIGKILL escalation
      const pids: number[] = [];
      if (deployment.agentServerPid) pids.push(deployment.agentServerPid);
      if (deployment.gatewayPid) pids.push(deployment.gatewayPid);
      await Promise.all(pids.map(killPidWithEscalation));
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
          gateway: state.gateway
            ? { pid: state.gateway.pid, exitCode: state.gateway.exitCode }
            : undefined,
          startTime: state.startTime,
        }
      : null;

    // Build health check callback if management API is configured
    let healthCheck: (() => Promise<boolean>) | undefined;
    if (deployment.managementPort && deployment.managementToken) {
      const { ManagementClient } = await import('@dash/management');
      const client = new ManagementClient(
        `http://localhost:${deployment.managementPort}`,
        deployment.managementToken,
      );
      healthCheck = async () => {
        try {
          await client.health();
          return true;
        } catch {
          return false;
        }
      };
    }

    return await resolveRuntimeStatus(snapshot, deployment, undefined, healthCheck);
  }

  async updateAgentConfig(
    id: string,
    patch: { model?: string; fallbackModels?: string[] },
  ): Promise<void> {
    const deployment = await this.registry.get(id);
    if (!deployment) throw new Error(`Deployment "${id}" not found`);

    const configDir = deployment.configDir;
    if (!configDir) throw new Error(`Deployment "${id}" has no config directory`);

    const agentsDir = join(configDir, 'agents');
    const files = await readdir(agentsDir);
    const jsonFile = files.find((f) => f.endsWith('.json'));
    if (!jsonFile) throw new Error(`No agent config file found in ${agentsDir}`);

    const filePath = join(agentsDir, jsonFile);
    const raw = await readFile(filePath, 'utf-8');
    const config = JSON.parse(raw) as Record<string, unknown>;

    if (patch.model !== undefined) config.model = patch.model;
    if (patch.fallbackModels !== undefined) config.fallbackModels = patch.fallbackModels;

    await writeFile(filePath, JSON.stringify(config, null, 2));
  }

  async *getLogs(id: string, signal?: AbortSignal): AsyncIterable<string> {
    const deployment = await this.registry.get(id);
    if (!deployment) {
      throw new Error(`Deployment "${id}" not found`);
    }

    if (!deployment.managementPort || !deployment.managementToken) {
      throw new Error(`Deployment "${id}" has no management API configured. Cannot retrieve logs.`);
    }

    const { ManagementClient } = await import('@dash/management');
    const client = new ManagementClient(
      `http://localhost:${deployment.managementPort}`,
      deployment.managementToken,
    );
    yield* client.streamLogs(signal);
  }
}
