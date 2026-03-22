import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { AgentRegistry } from '../agents/registry.js';
import type { MessagingAppRegistry } from '../messaging-apps/registry.js';
import { getPlatformDataDir } from '../platform-paths.js';
import { generateToken } from '../security/keygen.js';
import type { SecretStore } from '../security/secrets.js';
import {
  type GatewayChannelConfig,
  type GatewayHealthResponse,
  GatewayManagementClient,
  type RuntimeAgentConfig,
} from './gateway-client.js';
import { GatewayStateStore } from './gateway-state.js';
import { resolveRuntimeStatus } from './status.js';
import type { DeploymentRuntime, RuntimeStatus } from './types.js';

import { parseProviderSecretKey } from './provider-keys.js';
export { providerSecretKey, parseProviderSecretKey } from './provider-keys.js';

export interface GatewayOptions {
  gatewayDataDir: string;
  gatewayRuntimeDir?: string; // --data-dir passed to the gateway process
  makeGatewayClient?: (baseUrl: string, token: string) => GatewayManagementClient;
  managementPort?: number;
  channelPort?: number;
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

export class DeploymentStartupError extends Error {
  constructor(
    public readonly deploymentId: string,
    reason: string,
  ) {
    super(reason);
    this.name = 'DeploymentStartupError';
  }
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

// ---------------------------------------------------------------------------
// Internal agent config type — extends the shared type with credential mapping
// ---------------------------------------------------------------------------

interface AgentCfg {
  name: string;
  model: string;
  fallbackModels?: string[];
  systemPrompt: string;
  tools?: string[];
  workspace?: string;
  credentialKeys?: Record<string, string>;
  maxTokens?: number;
  skills?: { paths?: string[]; urls?: string[] };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read agent configs from an agents/ directory or dash.json. */
async function readAgentConfigs(absConfigDir: string): Promise<Record<string, AgentCfg>> {
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
        maxTokens: cfg.maxTokens,
        skills: cfg.skills,
      };
    }
  }

  if (Object.keys(agentConfigs).length === 0) {
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
            maxTokens: cfg.maxTokens,
            skills: cfg.skills,
          };
        }
      }
    }
  }

  return agentConfigs;
}

/**
 * Read all provider API keys from the secret store.
 * Returns nested `{ provider: { keyName: value } }`.
 */
async function resolveProviderApiKeys(
  secrets: SecretStore,
): Promise<Record<string, Record<string, string>>> {
  const allSecretKeys = await secrets.list();
  const providerApiKeys: Record<string, Record<string, string>> = {};
  for (const secretKey of allSecretKeys) {
    const parsed = parseProviderSecretKey(secretKey);
    if (!parsed) continue;
    const value = await secrets.get(secretKey);
    if (!value) continue;
    if (!providerApiKeys[parsed.provider]) {
      providerApiKeys[parsed.provider] = {};
    }
    providerApiKeys[parsed.provider][parsed.keyName] = value;
  }
  return providerApiKeys;
}

/**
 * Flatten nested provider keys into `Record<string, string>` per agent.
 *
 * The gateway runtime expects a flat map where each key is a provider name
 * and the value is the API key string. If the agent config has a
 * `credentialKeys` mapping (`{ providerName: keyName }`), use that to pick
 * the right key. Otherwise fall back to the `default` key (or the first
 * available key) for each provider.
 */
function flattenProviderKeys(
  providerApiKeys: Record<string, Record<string, string>>,
  agentCfg: AgentCfg,
): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const [provider, keys] of Object.entries(providerApiKeys)) {
    const preferredKeyName = agentCfg.credentialKeys?.[provider];
    if (preferredKeyName && keys[preferredKeyName]) {
      flat[provider] = keys[preferredKeyName];
    } else if (keys.default) {
      flat[provider] = keys.default;
    } else {
      // Pick the first available key
      const firstKey = Object.values(keys)[0];
      if (firstKey) flat[provider] = firstKey;
    }
  }
  return flat;
}

/**
 * Register messaging app channels with the gateway for the given agent names.
 */
async function registerMessagingApps(
  gatewayClient: GatewayManagementClient,
  messagingApps: MessagingAppRegistry,
  secrets: SecretStore,
  deploymentId: string,
  agentNames: string[],
): Promise<void> {
  const mcDataDir = process.env.MC_DATA_DIR || getPlatformDataDir('dash');
  const apps = await messagingApps.list();

  for (const app of apps) {
    if (!app.enabled) continue;
    const relevantRules = app.routing.filter((r) => agentNames.includes(r.targetAgentName));
    if (relevantRules.length === 0) continue;

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

      // Sync runtime auth state back into encrypted store, then bundle for gateway
      try {
        const { FileSecretStore } = await import('../security/secrets.js');
        const runtimeStore = new FileSecretStore(authStateDir);
        const runtimeKeys = await runtimeStore.list();
        const authPrefix = `${app.credentialsKey}:`;
        for (const key of runtimeKeys) {
          const val = await runtimeStore.get(key);
          if (val) await secrets.set(`${authPrefix}${key}`, val);
        }
      } catch {
        // No runtime state to sync (first deploy)
      }

      const authPrefix = `${app.credentialsKey}:`;
      const allKeys = await secrets.list();
      const authBlob: Record<string, string> = {};
      for (const k of allKeys.filter((k) => k.startsWith(authPrefix))) {
        const val = await secrets.get(k);
        if (val) authBlob[k.slice(authPrefix.length)] = val;
      }
      if (Object.keys(authBlob).length > 0) {
        channelConfig.whatsappAuth = authBlob;
      }
    } else {
      const token = await secrets.get(app.credentialsKey);
      if (!token) continue;
      channelConfig.token = token;
    }

    await gatewayClient.registerChannel(deploymentId, `messaging-app-${app.id}`, channelConfig);
  }
}

// ---------------------------------------------------------------------------
// ProcessRuntime
// ---------------------------------------------------------------------------

export class ProcessRuntime implements DeploymentRuntime {
  constructor(
    private registry: AgentRegistry,
    private secrets: SecretStore,
    private projectRoot: string,
    private spawner: ProcessSpawner = defaultProcessSpawner,
    private messagingApps?: MessagingAppRegistry,
    _startupWatcher?: unknown, // kept for constructor compatibility
    private gatewayOptions?: GatewayOptions,
  ) {}

  async ensureGateway(): Promise<GatewayManagementClient | null> {
    const opts = this.gatewayOptions;
    if (!opts) return null;

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
    const gatewayBin = join(this.projectRoot, 'apps/gateway/dist/index.js');
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

    const agents = deployment.config?.agents ?? {};
    const agentNames = Object.keys(agents);
    if (!agentNames.length) {
      console.warn(`registerWithGateway: deployment ${deploymentId} has no agents, skipping`);
      return;
    }

    // Resolve provider keys for credentials
    const providerApiKeys = await resolveProviderApiKeys(this.secrets);

    // Register each agent with the gateway runtime and set credentials
    for (const agentName of agentNames) {
      const agentCfg = agents[agentName];
      if (!agentCfg) continue;

      const runtimeConfig: RuntimeAgentConfig = {
        name: agentName,
        model: agentCfg.model,
        systemPrompt: agentCfg.systemPrompt,
        fallbackModels: agentCfg.fallbackModels,
        tools: agentCfg.tools,
        skills: agentCfg.skills,
        workspace: agentCfg.workspace,
        maxTokens: agentCfg.maxTokens,
      };

      try {
        await gatewayClient.registerRuntimeAgent(runtimeConfig);
      } catch (err) {
        console.warn(
          `registerWithGateway: failed to register agent ${agentName}:`,
          err instanceof Error ? err.message : err,
        );
        continue;
      }

      // Flatten and set credentials
      const flatKeys = flattenProviderKeys(providerApiKeys, agentCfg as AgentCfg);
      if (Object.keys(flatKeys).length > 0) {
        try {
          await gatewayClient.setRuntimeAgentCredentials(agentName, flatKeys);
        } catch (err) {
          console.warn(
            `registerWithGateway: failed to set credentials for ${agentName}:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
    }

    // Register messaging app channels
    if (this.messagingApps) {
      try {
        await registerMessagingApps(
          gatewayClient,
          this.messagingApps,
          this.secrets,
          deploymentId,
          agentNames,
        );
      } catch (err) {
        console.warn(
          'registerWithGateway: failed to register messaging apps:',
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  async deploy(configDir: string): Promise<string> {
    const absConfigDir = resolve(configDir);
    validateConfigDir(absConfigDir);

    // Read agent configs
    const agentConfigs = await readAgentConfigs(absConfigDir);
    const agentNames = Object.keys(agentConfigs);
    if (agentNames.length === 0) {
      throw new Error('No agent configurations found in config directory');
    }

    const id = randomUUID().slice(0, 8);

    // Resolve workspace for each agent and write back to config files
    const mcDataDir = process.env.MC_DATA_DIR || getPlatformDataDir('dash');
    for (const [name, cfg] of Object.entries(agentConfigs)) {
      if (!cfg.workspace) {
        cfg.workspace = join(mcDataDir, 'workspaces', `${name}-${id}`);
      }
      await mkdir(cfg.workspace, { recursive: true, mode: 0o700 });

      const agentFile = join(absConfigDir, 'agents', `${name}.json`);
      if (existsSync(agentFile)) {
        const raw = await readFile(agentFile, 'utf-8');
        const json = JSON.parse(raw) as Record<string, unknown>;
        json.workspace = cfg.workspace;
        await writeFile(agentFile, JSON.stringify(json, null, 2));
      }
    }

    // Resolve provider API keys
    const providerApiKeys = await resolveProviderApiKeys(this.secrets);
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

    // Register deployment with provisioning status
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

    // Ensure gateway is running
    const gatewayClient = await this.ensureGateway();
    if (!gatewayClient) {
      await this.registry.update(id, {
        status: 'error',
        errorMessage: 'No gateway configured',
      });
      throw new DeploymentStartupError(id, 'No gateway configured');
    }

    // Register each agent with gateway runtime API
    try {
      for (const [agentName, cfg] of Object.entries(agentConfigs)) {
        const runtimeConfig: RuntimeAgentConfig = {
          name: agentName,
          model: cfg.model,
          systemPrompt: cfg.systemPrompt,
          fallbackModels: cfg.fallbackModels,
          tools: cfg.tools,
          skills: cfg.skills,
          workspace: cfg.workspace,
          maxTokens: cfg.maxTokens,
        };
        await gatewayClient.registerRuntimeAgent(runtimeConfig);

        // Flatten and set credentials per agent
        const flatKeys = flattenProviderKeys(providerApiKeys, cfg);
        if (Object.keys(flatKeys).length > 0) {
          await gatewayClient.setRuntimeAgentCredentials(agentName, flatKeys);
        }
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await this.registry.update(id, {
        status: 'error',
        errorMessage: reason,
      });
      throw new DeploymentStartupError(id, reason);
    }

    // Register messaging app channels
    if (this.messagingApps) {
      try {
        await registerMessagingApps(
          gatewayClient,
          this.messagingApps,
          this.secrets,
          id,
          agentNames,
        );
      } catch (err) {
        console.warn(
          'deploy: messaging app registration failed:',
          err instanceof Error ? err.message : err,
        );
      }
    }

    // Update registry to running
    await this.registry.update(id, { status: 'running' });

    return id;
  }

  async start(id: string): Promise<void> {
    const deployment = await this.registry.get(id);
    if (!deployment) throw new Error(`Deployment "${id}" not found`);
    if (!deployment.configDir) throw new Error(`Deployment "${id}" has no config directory`);

    // Stop the old registration if still running
    if (deployment.status === 'running' || deployment.status === 'provisioning') {
      await this.stop(id);
    }

    // Read fresh agent configs from disk
    const agentConfigs = await readAgentConfigs(deployment.configDir);
    const agentNames = Object.keys(agentConfigs);
    if (agentNames.length === 0) {
      throw new Error('No agent configurations found in config directory');
    }

    // Resolve provider API keys
    const providerApiKeys = await resolveProviderApiKeys(this.secrets);
    if (Object.keys(providerApiKeys).length === 0) {
      throw new Error(
        'No provider API key configured. Add at least one API key in Mission Control Settings.',
      );
    }

    // Update registry to provisioning
    await this.registry.update(id, {
      status: 'provisioning',
      errorMessage: undefined,
      startupLogs: undefined,
    });

    // Ensure gateway and re-register
    const gatewayClient = await this.ensureGateway();
    if (!gatewayClient) {
      await this.registry.update(id, {
        status: 'error',
        errorMessage: 'No gateway configured',
      });
      throw new DeploymentStartupError(id, 'No gateway configured');
    }

    try {
      for (const [agentName, cfg] of Object.entries(agentConfigs)) {
        const runtimeConfig: RuntimeAgentConfig = {
          name: agentName,
          model: cfg.model,
          systemPrompt: cfg.systemPrompt,
          fallbackModels: cfg.fallbackModels,
          tools: cfg.tools,
          skills: cfg.skills,
          workspace: cfg.workspace,
          maxTokens: cfg.maxTokens,
        };
        await gatewayClient.registerRuntimeAgent(runtimeConfig);

        const flatKeys = flattenProviderKeys(providerApiKeys, cfg);
        if (Object.keys(flatKeys).length > 0) {
          await gatewayClient.setRuntimeAgentCredentials(agentName, flatKeys);
        }
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await this.registry.update(id, {
        status: 'error',
        errorMessage: reason,
      });
      throw new DeploymentStartupError(id, reason);
    }

    // Register messaging app channels
    if (this.messagingApps) {
      try {
        await registerMessagingApps(
          gatewayClient,
          this.messagingApps,
          this.secrets,
          id,
          agentNames,
        );
      } catch (err) {
        console.warn(
          'start: messaging app registration failed:',
          err instanceof Error ? err.message : err,
        );
      }
    }

    // Update registry to running
    await this.registry.update(id, { status: 'running' });
  }

  async stop(id: string): Promise<void> {
    const deployment = await this.registry.get(id);
    if (!deployment) {
      throw new Error(`Deployment "${id}" not found`);
    }

    const gatewayClient = await this.getGatewayClient();
    if (gatewayClient) {
      // Remove runtime agents for this deployment
      const agents = deployment.config?.agents ?? {};
      for (const agentName of Object.keys(agents)) {
        try {
          await gatewayClient.removeRuntimeAgent(agentName);
        } catch {
          // Best-effort: agent may already be removed or gateway down
        }
      }

      // Deregister channels
      await gatewayClient.deregisterDeployment(id);
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

    // If deployment claims to be running, verify with gateway
    if (deployment.status === 'running') {
      const gatewayClient = await this.getGatewayClient();
      if (gatewayClient) {
        const agents = deployment.config?.agents ?? {};
        const agentNames = Object.keys(agents);
        if (agentNames.length > 0) {
          try {
            const agentInfo = await gatewayClient.getRuntimeAgent(agentNames[0]);
            if (agentInfo.status === 'active') {
              return { state: 'running' };
            }
            if (agentInfo.status === 'registered') {
              return { state: 'running' };
            }
            if (agentInfo.status === 'disabled') {
              return { state: 'stopped' };
            }
          } catch {
            // Gateway may be down — fall through to registry status
          }
        }
      }
    }

    return await resolveRuntimeStatus(deployment);
  }

  async updateAgentConfig(
    id: string,
    patch: {
      name?: string;
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

    // Handle rename if name is provided and different
    const newName = patch.name?.trim();
    const isRename = newName && newName !== agentName && newName !== deployment.name;

    // 1. Write to config file on disk (for crash recovery / restart)
    const filePath = join(agentsDir, jsonFile);
    const raw = await readFile(filePath, 'utf-8');
    const config = JSON.parse(raw) as Record<string, unknown>;

    if (patch.model !== undefined) config.model = patch.model;
    if (patch.fallbackModels !== undefined) config.fallbackModels = patch.fallbackModels;
    if (patch.tools !== undefined) config.tools = patch.tools;
    if (patch.systemPrompt !== undefined) config.systemPrompt = patch.systemPrompt;
    if (newName) config.name = newName;

    // If renaming, write to new file and delete old one
    if (isRename) {
      const newFilePath = join(agentsDir, `${newName}.json`);
      await writeFile(newFilePath, JSON.stringify(config, null, 2));
      await rm(filePath);
    } else {
      await writeFile(filePath, JSON.stringify(config, null, 2));
    }

    // 2. Update registry so the UI reflects the change immediately
    if (deployment.config?.agents?.[agentName]) {
      const agentCfg = deployment.config.agents[agentName];
      if (patch.model !== undefined) agentCfg.model = patch.model;
      if (patch.fallbackModels !== undefined) agentCfg.fallbackModels = patch.fallbackModels;
      if (patch.tools !== undefined) agentCfg.tools = patch.tools;
      if (patch.systemPrompt !== undefined) agentCfg.systemPrompt = patch.systemPrompt;

      // If renaming, update the agents dict key and deployment name
      if (isRename) {
        agentCfg.name = newName;
        delete deployment.config.agents[agentName];
        deployment.config.agents[newName] = agentCfg;
        await this.registry.update(id, { name: newName, config: deployment.config });
      } else {
        await this.registry.update(id, { config: deployment.config });
      }
    } else if (isRename) {
      // No agents config but still update deployment name
      await this.registry.update(id, { name: newName });
    }

    // 3. Push to running agent via gateway runtime API (best-effort)
    // Note: name changes require restart to take effect in gateway
    if (deployment.status === 'running' && !isRename) {
      const gatewayClient = await this.getGatewayClient();
      if (gatewayClient) {
        try {
          const runtimePatch: Partial<RuntimeAgentConfig> = {};
          if (patch.model !== undefined) runtimePatch.model = patch.model;
          if (patch.fallbackModels !== undefined)
            runtimePatch.fallbackModels = patch.fallbackModels;
          if (patch.tools !== undefined) runtimePatch.tools = patch.tools;
          if (patch.systemPrompt !== undefined) runtimePatch.systemPrompt = patch.systemPrompt;
          await gatewayClient.updateRuntimeAgent(agentName, runtimePatch);
        } catch (err) {
          console.warn(
            'updateAgentConfig: gateway update failed (will apply on restart):',
            err instanceof Error ? err.message : err,
          );
        }
      }
    }
  }

  async *getLogs(id: string, _signal?: AbortSignal): AsyncIterable<string> {
    const deployment = await this.registry.get(id);
    if (!deployment) {
      throw new Error(`Deployment "${id}" not found`);
    }

    // Gateway log streaming not wired yet
    yield '[warn] Log streaming not yet available (pending gateway log streaming)';
  }
}
