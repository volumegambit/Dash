import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { chmod, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AgentRegistry } from '../agents/registry.js';
import type { MessagingAppRegistry } from '../messaging-apps/registry.js';
import { getPlatformDataDir } from '../platform-paths.js';
import { generateToken } from '../security/keygen.js';
import type { SecretStore } from '../security/secrets.js';
import type { MessagingApp } from '../types.js';
import {
  type GatewayChannelConfig,
  type GatewayHealthResponse,
  GatewayManagementClient,
} from './gateway-client.js';
import { GatewayStateStore } from './gateway-state.js';
import { resolveRuntimeStatus } from './status.js';
import type { DeploymentRuntime, RuntimeStatus } from './types.js';

import { parseProviderSecretKey } from './provider-keys.js';
export { providerSecretKey, parseProviderSecretKey } from './provider-keys.js';

interface ProcessState {
  agentServer: SpawnedProcess;
  startTime: number;
}

export interface GatewayOptions {
  gatewayDataDir: string;
  gatewayRuntimeDir?: string; // --data-dir passed to the gateway process
  makeGatewayClient?: (baseUrl: string, token: string) => GatewayManagementClient;
  managementPort?: number;
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

export type StartupResult = { success: true } | { success: false; logs: string[]; reason: string };

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
        const ok = await healthChecker(managementPort);
        if (settled) return; // check again after async gap
        healthOk = ok;
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

export class DeploymentStartupError extends Error {
  constructor(
    public readonly deploymentId: string,
    reason: string,
  ) {
    super(reason);
    this.name = 'DeploymentStartupError';
  }
}

export type StartupWatcher = (
  child: SpawnedProcess,
  managementPort: number,
) => Promise<StartupResult>;

export const defaultStartupWatcher: StartupWatcher = (child, port) =>
  waitForStartup(child, port, 10_000);

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
  providerApiKeys?: Record<string, Record<string, string>>;
  managementToken: string;
  chatToken: string;
}

export interface ResolvedMessagingApp {
  app: MessagingApp;
  token: string;
  authStateDir?: string; // for whatsapp channels
}

export async function writeSecretsFile(secrets: AgentSecretsFile, prefix: string): Promise<string> {
  const filePath = join(tmpdir(), `${prefix}-${randomUUID()}.json`);
  await writeFile(filePath, JSON.stringify(secrets, null, 2), { mode: 0o600 });
  await chmod(filePath, 0o600);
  return filePath;
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
    private startupWatcher: StartupWatcher = defaultStartupWatcher,
    private gatewayOptions?: GatewayOptions,
  ) {}

  async ensureGateway(): Promise<GatewayManagementClient | null> {
    const opts = this.gatewayOptions;
    if (!opts) return null;

    const managementPort = opts.managementPort ?? 9300;
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
    const gatewayBin = join(this.projectRoot, 'apps/gateway/dist/index.js');
    const spawnArgs = [gatewayBin, '--management-port', String(managementPort), '--token', token];
    if (opts.gatewayRuntimeDir) {
      spawnArgs.push('--data-dir', opts.gatewayRuntimeDir);
    }
    const gateway = this.spawner.spawn('node', spawnArgs, {
      env: { ...process.env },
      stdio: ['ignore', 'ignore', 'ignore'],
      detached: true,
    });
    (gateway as { unref?: () => void }).unref?.();

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
    // TODO: Task 3 will resolve channelPort from gateway health response
    const channelPort = managementPort + 1;
    await store.write({
      pid: gatewayPid,
      startedAt: health.startedAt,
      token,
      port: managementPort,
      channelPort,
    });

    return newClient;
  }

  private async getGatewayClient(): Promise<GatewayManagementClient | null> {
    const opts = this.gatewayOptions;
    if (!opts) return null;
    const store = new GatewayStateStore(opts.gatewayDataDir);
    const state = await store.read();
    if (!state) return null;
    const makeClient =
      opts.makeGatewayClient ?? ((url, token) => new GatewayManagementClient(url, token));
    return makeClient(`http://localhost:${state.port}`, state.token);
  }

  async registerWithGateway(deploymentId: string): Promise<void> {
    const deployment = await this.registry.get(deploymentId);
    if (!deployment || deployment.status !== 'running') return;

    const gatewayClient = await this.getGatewayClient();
    if (!gatewayClient) return;

    const agentNames = Object.keys(deployment.config?.agents ?? {});
    if (!agentNames.length) {
      console.warn(`registerWithGateway: deployment ${deploymentId} has no agents, skipping`);
      return;
    }

    // TODO: Task 3 will rewrite this to use gateway runtime API instead of
    // direct agent server WebSocket connections
    console.warn(
      `registerWithGateway: skipping agent registration for ${deploymentId} (process fields removed)`,
    );

    if (this.messagingApps) {
      const mcDataDir = process.env.MC_DATA_DIR || getPlatformDataDir('dash');
      const apps = await this.messagingApps.list();
      for (const app of apps) {
        if (!app.enabled) continue;
        const relevantRules = app.routing.filter((r) => agentNames.includes(r.targetAgentName));
        if (relevantRules.length === 0) continue;

        const token =
          app.type !== 'whatsapp' ? await this.secrets.get(app.credentialsKey) : undefined;
        if (app.type !== 'whatsapp' && !token) continue;

        const channelConfig: GatewayChannelConfig = {
          adapter: app.type as 'telegram' | 'whatsapp',
          globalDenyList: app.globalDenyList,
          routing: relevantRules.map((r) => ({
            condition: r.condition,
            agentName: r.targetAgentName,
            allowList: r.allowList ?? [],
            denyList: r.denyList ?? [],
          })),
        };
        if (app.type === 'whatsapp') {
          const authStateDir = join(mcDataDir, 'whatsapp-sessions', app.id);
          channelConfig.authStateDir = authStateDir;

          const authPrefix = `${app.credentialsKey}:`;
          const allKeys = await this.secrets.list();
          const authBlob: Record<string, string> = {};
          for (const k of allKeys.filter((k) => k.startsWith(authPrefix))) {
            const val = await this.secrets.get(k);
            if (val) authBlob[k.slice(authPrefix.length)] = val;
          }
          if (Object.keys(authBlob).length > 0) {
            channelConfig.whatsappAuth = authBlob;
          }
        } else {
          channelConfig.token = token ?? undefined;
        }

        await gatewayClient.registerChannel(deploymentId, `messaging-app-${app.id}`, channelConfig);
      }
    }
  }

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
      opencodeStateDir?: string;
      credentialKeys?: Record<string, string>;
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
          credentialKeys: cfg.credentialKeys,
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
              credentialKeys: cfg.credentialKeys,
            };
          }
        }
      }
    }

    const agentNames = Object.keys(agentConfigs);
    if (agentNames.length === 0) {
      throw new Error('No agent configurations found in config directory');
    }

    // Allocate ports
    const [managementPort, chatPort] = await Promise.all([
      findAvailablePort(),
      findAvailablePort(),
    ]);

    // Generate tokens
    const managementToken = generateToken();
    const chatToken = generateToken();
    const id = randomUUID().slice(0, 8);

    // Resolve workspace and OpenCode state dir for each agent,
    // then write back to the agent config JSON so the agent server picks them up.
    const mcDataDir = process.env.MC_DATA_DIR || getPlatformDataDir('dash');
    const agentDataDir = getPlatformDataDir('dash-agent');
    for (const [name, cfg] of Object.entries(agentConfigs)) {
      if (!cfg.workspace) {
        cfg.workspace = join(mcDataDir, 'workspaces', `${name}-${id}`);
      }
      await mkdir(cfg.workspace, { recursive: true, mode: 0o700 });

      // Isolated OpenCode state per-deployment (DB, auth, sessions)
      cfg.opencodeStateDir = join(agentDataDir, 'opencode', `${name}-${id}`);
      await mkdir(cfg.opencodeStateDir, { recursive: true, mode: 0o700 });

      // Write resolved paths back to the agent config file
      const agentFile = join(absConfigDir, 'agents', `${name}.json`);
      if (existsSync(agentFile)) {
        const raw = await readFile(agentFile, 'utf-8');
        const json = JSON.parse(raw) as Record<string, unknown>;
        json.workspace = cfg.workspace;
        json.opencodeStateDir = cfg.opencodeStateDir;
        await writeFile(agentFile, JSON.stringify(json, null, 2));
      }
    }

    // Store tokens in secret store
    await this.secrets.set(`agent-token:${id}`, managementToken);
    await this.secrets.set(`chat-token:${id}`, chatToken);

    // Read provider API keys from secret store
    const allSecretKeys = await this.secrets.list();
    const providerApiKeys: Record<string, Record<string, string>> = {};
    for (const secretKey of allSecretKeys) {
      const parsed = parseProviderSecretKey(secretKey);
      if (!parsed) continue;
      const value = await this.secrets.get(secretKey);
      if (!value) continue;
      if (!providerApiKeys[parsed.provider]) {
        providerApiKeys[parsed.provider] = {};
      }
      providerApiKeys[parsed.provider][parsed.keyName] = value;
    }

    if (Object.keys(providerApiKeys).length === 0) {
      throw new Error(
        'No provider API key configured. Add at least one API key in Mission Control Settings.',
      );
    }

    // Validate that each agent's primary model has a matching provider API key
    for (const [name, cfg] of Object.entries(agentConfigs)) {
      if (!cfg.model.includes('/')) continue;
      const providerID = cfg.model.split('/')[0];
      if (providerID && !providerApiKeys[providerID]) {
        throw new Error(
          `No API key configured for provider '${providerID}'. Add a key in Mission Control Settings → AI Providers, or change the agent model to one you have a key for.`,
        );
      }
      if (cfg.credentialKeys?.[providerID]) {
        const keyName = cfg.credentialKeys[providerID];
        if (!providerApiKeys[providerID]?.[keyName]) {
          throw new Error(
            `Agent "${name}" requires credential "${keyName}" for provider "${providerID}", but no key with that name exists.`,
          );
        }
      }
    }

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

        if (app.type === 'whatsapp') {
          const authStateDir = join(mcDataDir, 'whatsapp-sessions', app.id);
          resolvedApps.push({ app, token: '', authStateDir });
        } else {
          const token = await this.secrets.get(app.credentialsKey);
          if (token) {
            resolvedApps.push({ app, token });
          }
        }
      }
    }

    // Collect WhatsApp auth blobs for messaging apps
    const whatsappAuthBlobs = new Map<string, Record<string, string>>();
    for (const { app, authStateDir } of resolvedApps) {
      if (app.type !== 'whatsapp') continue;

      const channelKey = `messaging-app-${app.id}`;
      const authPrefix = `${app.credentialsKey}:`;

      // 1. Sync any runtime FileStore updates back into EncryptedSecretStore
      // (Runtime updates from previous gateway runs are stored in authStateDir/auth.json)
      if (!authStateDir) continue;
      try {
        const { FileSecretStore } = await import('../security/secrets.js');
        const runtimeStore = new FileSecretStore(authStateDir);
        const runtimeKeys = await runtimeStore.list();
        for (const key of runtimeKeys) {
          const val = await runtimeStore.get(key);
          if (val) await this.secrets.set(`${authPrefix}${key}`, val);
        }
      } catch {
        // No runtime state to sync (first deploy)
      }

      // 2. Read all auth keys from encrypted store and bundle as blob
      const allKeys = await this.secrets.list();
      const authBlob: Record<string, string> = {};
      for (const k of allKeys.filter((k) => k.startsWith(authPrefix))) {
        const val = await this.secrets.get(k);
        if (val) authBlob[k.slice(authPrefix.length)] = val;
      }

      if (Object.keys(authBlob).length > 0) {
        whatsappAuthBlobs.set(channelKey, authBlob);
      }
    }

    // Register deployment immediately with provisioning status
    const name = agentNames[0] ?? 'deployment';
    await this.registry.add({
      id,
      name,
      target: 'local',
      status: 'provisioning',
      config: {
        target: 'local',
        agents: agentConfigs,
        channels: {},
      },
      createdAt: new Date().toISOString(),
      configDir: absConfigDir,
      workspace: agentConfigs[agentNames[0]]?.workspace,
    });

    // Spawn agent-server with piped stdio for startup monitoring
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
        detached: false,
      },
    );

    // Wait for startup confirmation
    const startupResult = await this.startupWatcher(agentServer, managementPort);

    if (!startupResult.success) {
      // Kill the process if still alive
      if (agentServer.exitCode === null) {
        agentServer.kill('SIGKILL');
      }
      // Destroy streams
      (agentServer.stdout as { destroy?: () => void } | undefined)?.destroy?.();
      (agentServer.stderr as { destroy?: () => void } | undefined)?.destroy?.();

      // Update registry with error state
      await this.registry.update(id, {
        status: 'error',
        errorMessage: startupResult.reason,
        startupLogs: startupResult.logs,
      });

      throw new DeploymentStartupError(id, startupResult.reason);
    }

    // Success: detach process and release streams
    (agentServer as { unref?: () => void }).unref?.();
    (agentServer.stdout as { destroy?: () => void } | undefined)?.destroy?.();
    (agentServer.stderr as { destroy?: () => void } | undefined)?.destroy?.();

    // Ensure shared gateway is running and register this deployment
    const gatewayClient = await this.ensureGateway();
    if (gatewayClient) {
      // Register agent(s)
      for (const agentName of agentNames) {
        await gatewayClient.registerAgent(
          id,
          agentName,
          `ws://localhost:${chatPort}/ws`,
          chatToken,
        );
      }

      // Register messaging app channels
      for (const { app, token: appToken, authStateDir } of resolvedApps) {
        if (!app.enabled) continue;
        const relevantRules = app.routing.filter((r) => agentNames.includes(r.targetAgentName));
        if (relevantRules.length === 0) continue;

        const channelConfig: GatewayChannelConfig = {
          adapter: app.type,
          globalDenyList: app.globalDenyList,
          routing: relevantRules.map((r) => ({
            condition: r.condition,
            agentName: r.targetAgentName,
            allowList: r.allowList,
            denyList: r.denyList,
          })),
        };
        if (app.type === 'whatsapp') {
          channelConfig.authStateDir = authStateDir;
          channelConfig.whatsappAuth = whatsappAuthBlobs.get(`messaging-app-${app.id}`);
        } else {
          channelConfig.token = appToken;
        }

        await gatewayClient.registerChannel(id, `messaging-app-${app.id}`, channelConfig);
      }
    }

    this.processes.set(id, { agentServer, startTime: Date.now() });

    // Update registry to running
    // TODO: Task 3 will remove PID tracking entirely
    await this.registry.update(id, {
      status: 'running',
    });

    // Watch for process exit after successful startup
    agentServer.on('exit', async () => {
      if (!this.processes.get(id)) return;
      try {
        await this.registry.update(id, { status: 'stopped' });
      } catch {
        // Registry update can fail if already removed
      }
    });

    return id;
  }

  async start(id: string): Promise<void> {
    const deployment = await this.registry.get(id);
    if (!deployment) throw new Error(`Deployment "${id}" not found`);
    if (!deployment.configDir) throw new Error(`Deployment "${id}" has no config directory`);

    // Stop the old process if still running
    if (deployment.status === 'running' || deployment.status === 'provisioning') {
      await this.stop(id);
    }

    // Allocate fresh ports and tokens
    const [managementPort, chatPort] = await Promise.all([
      findAvailablePort(),
      findAvailablePort(),
    ]);
    const managementToken = generateToken();
    const chatToken = generateToken();

    // Update stored tokens
    await this.secrets.set(`agent-token:${id}`, managementToken);
    await this.secrets.set(`chat-token:${id}`, chatToken);

    // Read fresh provider API keys from secret store
    const allSecretKeys = await this.secrets.list();
    const providerApiKeys: Record<string, Record<string, string>> = {};
    for (const secretKey of allSecretKeys) {
      const parsed = parseProviderSecretKey(secretKey);
      if (!parsed) continue;
      const value = await this.secrets.get(secretKey);
      if (!value) continue;
      if (!providerApiKeys[parsed.provider]) {
        providerApiKeys[parsed.provider] = {};
      }
      providerApiKeys[parsed.provider][parsed.keyName] = value;
    }

    if (Object.keys(providerApiKeys).length === 0) {
      throw new Error(
        'No provider API key configured. Add at least one API key in Mission Control Settings.',
      );
    }

    // Write temp secrets file
    const agentSecretsFile: AgentSecretsFile = {
      providerApiKeys,
      managementToken,
      chatToken,
    };
    const agentSecretsPath = await writeSecretsFile(agentSecretsFile, 'agent-secrets');

    // Update registry to provisioning
    // TODO: Task 3 will remove port/token fields from registry updates
    await this.registry.update(id, {
      status: 'provisioning',
      errorMessage: undefined,
      startupLogs: undefined,
    });

    // Spawn agent-server
    const agentServerBin = join(this.projectRoot, 'apps/dash/dist/index.js');
    const agentServer = this.spawner.spawn(
      'node',
      [agentServerBin, '--config', deployment.configDir, '--secrets', agentSecretsPath],
      {
        env: {
          ...process.env,
          MANAGEMENT_API_PORT: String(managementPort),
          CHAT_API_PORT: String(chatPort),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      },
    );

    // Wait for startup
    const startupResult = await this.startupWatcher(agentServer, managementPort);

    if (!startupResult.success) {
      if (agentServer.exitCode === null) agentServer.kill('SIGKILL');
      (agentServer.stdout as { destroy?: () => void } | undefined)?.destroy?.();
      (agentServer.stderr as { destroy?: () => void } | undefined)?.destroy?.();

      await this.registry.update(id, {
        status: 'error',
        errorMessage: startupResult.reason,
        startupLogs: startupResult.logs,
      });

      throw new DeploymentStartupError(id, startupResult.reason);
    }

    // Success
    (agentServer as { unref?: () => void }).unref?.();
    (agentServer.stdout as { destroy?: () => void } | undefined)?.destroy?.();
    (agentServer.stderr as { destroy?: () => void } | undefined)?.destroy?.();

    // Re-register with gateway
    const gatewayClient = await this.ensureGateway();
    if (gatewayClient) {
      await this.registerWithGateway(id);
    }

    this.processes.set(id, { agentServer, startTime: Date.now() });

    // TODO: Task 3 will remove PID tracking entirely
    await this.registry.update(id, {
      status: 'running',
    });

    agentServer.on('exit', async () => {
      if (!this.processes.get(id)) return;
      try {
        await this.registry.update(id, { status: 'stopped' });
      } catch {
        // Registry update can fail if already removed
      }
    });
  }

  async stop(id: string): Promise<void> {
    const deployment = await this.registry.get(id);
    if (!deployment) {
      throw new Error(`Deployment "${id}" not found`);
    }

    // Deregister from shared gateway (best-effort)
    const gatewayClient = await this.getGatewayClient();
    if (gatewayClient) {
      await gatewayClient.deregisterDeployment(id); // already swallows errors
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

      this.processes.delete(id);
      await killProcess(state.agentServer);
    } else {
      // TODO: Task 3 will remove PID-based kill — agents are managed via gateway runtime API
    }

    await this.registry.update(id, { status: 'stopped' });
  }

  async remove(id: string): Promise<void> {
    const deployment = await this.registry.get(id);
    if (!deployment) {
      throw new Error(`Deployment "${id}" not found`);
    }

    // Stop if running
    if (deployment.status === 'running' || deployment.status === 'provisioning') {
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

    // TODO: Task 3 will query gateway runtime API for live status
    return await resolveRuntimeStatus(deployment);
  }

  async updateAgentConfig(
    id: string,
    patch: {
      model?: string;
      fallbackModels?: string[];
      tools?: string[];
      systemPrompt?: string;
    },
  ): Promise<void> {
    const deployment = await this.registry.get(id);
    if (!deployment) throw new Error(`Deployment "${id}" not found`);

    const configDir = deployment.configDir;
    if (!configDir) throw new Error(`Deployment "${id}" has no config directory`);

    const agentsDir = join(configDir, 'agents');
    const files = await readdir(agentsDir);
    const jsonFile = files.find((f) => f.endsWith('.json'));
    if (!jsonFile) throw new Error(`No agent config file found in ${agentsDir}`);
    const agentName = jsonFile.slice(0, -5);

    // 1. Write to config file on disk (for crash recovery / restart)
    const filePath = join(agentsDir, jsonFile);
    const raw = await readFile(filePath, 'utf-8');
    const config = JSON.parse(raw) as Record<string, unknown>;

    if (patch.model !== undefined) config.model = patch.model;
    if (patch.fallbackModels !== undefined) config.fallbackModels = patch.fallbackModels;
    if (patch.tools !== undefined) config.tools = patch.tools;
    if (patch.systemPrompt !== undefined) config.systemPrompt = patch.systemPrompt;

    await writeFile(filePath, JSON.stringify(config, null, 2));

    // 2. Update registry so the UI reflects the change immediately
    if (deployment.config?.agents?.[agentName]) {
      const agentCfg = deployment.config.agents[agentName];
      if (patch.model !== undefined) agentCfg.model = patch.model;
      if (patch.fallbackModels !== undefined) agentCfg.fallbackModels = patch.fallbackModels;
      if (patch.tools !== undefined) agentCfg.tools = patch.tools;
      if (patch.systemPrompt !== undefined) agentCfg.systemPrompt = patch.systemPrompt;
      await this.registry.update(id, { config: deployment.config });
    }

    // 3. Push to running agent server (best-effort)
    // TODO: Task 3 will push config updates via gateway runtime API
    // For now, config is saved to disk and registry — will apply on next restart
  }

  async *getLogs(id: string, _signal?: AbortSignal): AsyncIterable<string> {
    const deployment = await this.registry.get(id);
    if (!deployment) {
      throw new Error(`Deployment "${id}" not found`);
    }

    // TODO: Task 3 will retrieve logs via gateway runtime API
    yield '[warn] Log streaming not yet available (pending gateway runtime API migration)';
  }
}
