import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SkillsConfig } from '@dash/management';
import { ManagementClient } from '@dash/management';
import {
  AgentRegistry,
  ConversationStore,
  DeploymentStartupError,
  EncryptedSecretStore,
  GatewayManagementClient,
  GatewayStateStore,
  MessagingAppRegistry,
  ModelCacheService,
  ProcessRuntime,
  SettingsStore,
  defaultProcessSpawner,
  getPlatformDataDir,
  parseProviderSecretKey,
  providerSecretKey,
} from '@dash/mc';
import type { MessagingApp, ProcessSpawner } from '@dash/mc';
import { app, dialog, ipcMain, safeStorage, shell } from 'electron';
import type { BrowserWindow } from 'electron';
import type { DeployWithConfigOptions } from '../shared/ipc.js';
import { ChatService } from './chat-service.js';
import { completeClaudeOAuth, prepareClaudeOAuth } from './claude-auth.js';
import { refreshCodexToken, startCodexOAuth } from './codex-auth.js';
import { GatewayPoller } from './gateway-poller.js';

const DATA_DIR = process.env.MC_DATA_DIR || getPlatformDataDir('dash');
const SESSION_KEY_PATH = join(DATA_DIR, 'session.key');

let chatService: ChatService | undefined;
let secretStore: EncryptedSecretStore | undefined;
let registry: AgentRegistry | undefined;
let runtime: ProcessRuntime | undefined;
let messagingAppRegistry: MessagingAppRegistry | undefined;
let gatewayPoller: GatewayPoller | undefined;
let modelCache: ModelCacheService | undefined;

function getModelCache(): ModelCacheService {
  if (!modelCache) {
    modelCache = new ModelCacheService(DATA_DIR);
  }
  return modelCache;
}

async function getProviderApiKeys(): Promise<Record<string, string>> {
  const store = getSecretStore();
  const keys: Record<string, string> = {};
  try {
    const allKeys = await store.list();
    for (const secretKey of allKeys) {
      const parsed = parseProviderSecretKey(secretKey);
      if (!parsed) continue;
      // Only use the 'default' key per provider for discovery
      if (parsed.keyName !== 'default') continue;
      const value = await store.get(secretKey);
      if (value) keys[parsed.provider] = value;
    }
  } catch {
    // Secret store may be locked — return empty
  }
  return keys;
}

function getMessagingAppRegistry(): MessagingAppRegistry {
  if (!messagingAppRegistry) {
    messagingAppRegistry = new MessagingAppRegistry(DATA_DIR);
  }
  return messagingAppRegistry;
}

const logSubscriptions = new Map<string, AbortController>();

function getSecretStore(): EncryptedSecretStore {
  if (!secretStore) {
    secretStore = new EncryptedSecretStore(DATA_DIR);
  }
  return secretStore;
}

function getRegistry(): AgentRegistry {
  if (!registry) {
    registry = new AgentRegistry(DATA_DIR);
  }
  return registry;
}

function getChatService(getWindow: () => BrowserWindow | undefined): ChatService {
  if (!chatService) {
    chatService = new ChatService(
      getRegistry(),
      new ConversationStore(DATA_DIR),
      (conversationId, event) => {
        const win = getWindow();
        if (win && !win.isDestroyed()) win.webContents.send('chat:event', conversationId, event);
      },
      (conversationId) => {
        const win = getWindow();
        if (win && !win.isDestroyed()) win.webContents.send('chat:done', conversationId);
      },
      (conversationId, error) => {
        const win = getWindow();
        if (win && !win.isDestroyed()) win.webContents.send('chat:error', conversationId, error);
      },
    );
  }
  return chatService;
}

export function makePackagedSpawner(
  execPath: string,
  base: ProcessSpawner,
  isPackaged: boolean,
): ProcessSpawner {
  return {
    spawn: (command, args, options) => {
      if (command === 'node' && isPackaged) {
        return base.spawn(execPath, args, {
          ...options,
          env: { ...options.env, ELECTRON_RUN_AS_NODE: '1' },
        });
      }
      return base.spawn(command, args, options);
    },
  };
}

function resolveProjectRoot(): string {
  if (app.isPackaged) {
    return process.resourcesPath;
  }
  if (process.env.DASH_PROJECT_ROOT) {
    return process.env.DASH_PROJECT_ROOT;
  }
  // Dev: __dirname is apps/mission-control/out/main, 4 levels up is monorepo root
  return join(__dirname, '../../../..');
}

function getRuntime(): ProcessRuntime {
  if (!runtime) {
    runtime = new ProcessRuntime(
      getRegistry(),
      getSecretStore(),
      resolveProjectRoot(),
      makePackagedSpawner(process.execPath, defaultProcessSpawner, app.isPackaged),
      getMessagingAppRegistry(),
      undefined,
      {
        gatewayDataDir: DATA_DIR,
        gatewayRuntimeDir: getPlatformDataDir('dash-gateway'),
      },
    );
  }
  return runtime;
}

function getSettingsStore(): SettingsStore {
  return new SettingsStore(DATA_DIR);
}

async function getSkillsClient(_deploymentId: string): Promise<ManagementClient> {
  const gatewayState = await new GatewayStateStore(DATA_DIR).read();
  if (!gatewayState) {
    throw new Error('Gateway not running — Skills API unavailable');
  }
  return new ManagementClient(`http://127.0.0.1:${gatewayState.port}`, gatewayState.token);
}

function cacheKey(key: Buffer): void {
  if (!safeStorage.isEncryptionAvailable()) return;
  const encrypted = safeStorage.encryptString(key.toString('hex'));
  writeFileSync(SESSION_KEY_PATH, encrypted, { mode: 0o600 });
}

function loadCachedKey(): Buffer | null {
  if (!safeStorage.isEncryptionAvailable()) return null;
  if (!existsSync(SESSION_KEY_PATH)) return null;
  try {
    const encrypted = readFileSync(SESSION_KEY_PATH);
    const hex = safeStorage.decryptString(encrypted);
    return Buffer.from(hex, 'hex');
  } catch {
    return null;
  }
}

function clearCachedKey(): void {
  if (existsSync(SESSION_KEY_PATH)) {
    unlinkSync(SESSION_KEY_PATH);
  }
}

interface CredentialPushResult {
  total: number;
  succeeded: number;
  failed: { deploymentId: string; name: string; error: string }[];
}

async function pushCredentialsToRunningDeployments(): Promise<CredentialPushResult> {
  const store = getSecretStore();
  if (!store.isUnlocked()) return { total: 0, succeeded: 0, failed: [] };

  // Collect all provider API keys (flattened: provider -> default key value)
  const allKeys = await store.list();
  const flatKeys: Record<string, string> = {};
  for (const key of allKeys) {
    const parsed = parseProviderSecretKey(key);
    if (!parsed) continue;
    if (parsed.keyName !== 'default') continue;
    const value = await store.get(key);
    if (value) flatKeys[parsed.provider] = value;
  }

  // Read gateway state to get a management client
  const gatewayState = await new GatewayStateStore(DATA_DIR).read();
  if (!gatewayState) {
    return { total: 0, succeeded: 0, failed: [] };
  }

  const gwClient = new GatewayManagementClient(
    `http://127.0.0.1:${gatewayState.port}`,
    gatewayState.token,
  );

  // Push credentials to each runtime agent registered in the gateway
  let agents: { name: string }[];
  try {
    agents = await gwClient.listRuntimeAgents();
  } catch {
    return { total: 0, succeeded: 0, failed: [] };
  }

  const result: CredentialPushResult = { total: agents.length, succeeded: 0, failed: [] };

  for (const agent of agents) {
    try {
      await gwClient.setRuntimeAgentCredentials(agent.name, flatKeys);
      result.succeeded++;
    } catch (err) {
      result.failed.push({
        deploymentId: agent.name,
        name: agent.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (result.failed.length > 0) {
    console.warn(
      `[credentials] Push completed: ${result.succeeded}/${result.total} succeeded, ${result.failed.length} failed`,
    );
  }

  return result;
}

export async function registerIpcHandlers(
  getWindow: () => BrowserWindow | undefined,
): Promise<void> {
  // Start shared gateway
  const rt = getRuntime();
  try {
    await rt.ensureGateway();
  } catch (err) {
    console.error('Gateway startup failed on MC launch:', err);
  }

  // Read gateway state and pass connection to ChatService
  const refreshChatServiceConnection = async () => {
    const gatewayState = await new GatewayStateStore(DATA_DIR).read();
    if (gatewayState) {
      getChatService(getWindow).setGatewayConnection({
        channelPort: gatewayState.channelPort,
        chatToken: gatewayState.chatToken,
      });
    }
  };
  await refreshChatServiceConnection();

  // Start gateway health poller
  const sendGatewayStatus = (status: string) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send('gateway:status', status);
  };
  gatewayPoller = new GatewayPoller(
    () => rt.ensureGateway(),
    async () => {
      // Gateway self-restores agents from its own persistent registry.
      // Just refresh the chat service connection.
      await refreshChatServiceConnection();
    },
  );
  gatewayPoller.start(sendGatewayStatus);

  // SSE subscription to gateway events
  let sseAbort: AbortController | null = null;

  async function connectToGatewayEvents(): Promise<void> {
    sseAbort?.abort();
    const gatewayState = await new GatewayStateStore(DATA_DIR).read();
    if (!gatewayState) return;

    const abort = new AbortController();
    sseAbort = abort;

    try {
      const res = await fetch(`http://127.0.0.1:${gatewayState.port}/events`, {
        headers: { Authorization: `Bearer ${gatewayState.token}` },
        signal: abort.signal,
      });
      if (!res.ok || !res.body) return;

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        let eventType = '';
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            eventType = line.slice(7).trim();
          } else if (line.startsWith('data: ') && eventType) {
            const data = line.slice(6);
            const win = getWindow();
            if (win && !win.isDestroyed()) {
              win.webContents.send('gateway:event', eventType, data);
            }
            eventType = '';
          }
        }
      }
    } catch (err) {
      if (!abort.signal.aborted) {
        console.warn(
          '[sse] Gateway event stream disconnected:',
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  // Connect to SSE after initial gateway health check
  connectToGatewayEvents().catch(() => {});

  // Auto-unlock from cached session key.
  // Validates the key before registering IPC handlers so the renderer never
  // sees isUnlocked=true with a stale key.
  const cachedKey = loadCachedKey();
  if (cachedKey) {
    const store = getSecretStore();
    store.unlock(cachedKey);
    try {
      await store.list();
    } catch {
      store.lock();
      clearCachedKey();
    }
  }

  // Gateway self-restores agents from its own persistent registry on startup.
  // No re-registration needed from MC.

  ipcMain.handle('app:getVersion', () => app.getVersion());

  // Shell
  ipcMain.handle('openExternal', async (_event, url: string) => {
    await shell.openExternal(url);
  });

  ipcMain.handle('openPath', async (_event, path: string) => {
    if (!existsSync(path)) {
      await mkdir(path, { recursive: true });
    }
    await shell.openPath(path);
  });

  ipcMain.handle('dialog:openDirectory', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  // Setup handler
  ipcMain.handle('setup:getStatus', async () => {
    const store = getSecretStore();
    const needsSetup = await store.needsSetup();
    if (needsSetup) {
      return { needsSetup: true, needsUnlock: false, needsApiKey: true };
    }
    if (!store.isUnlocked()) {
      // Secrets exist but are locked — need unlock, NOT setup
      return { needsSetup: false, needsUnlock: true, needsApiKey: false };
    }
    const allKeys = await store.list();
    const hasAnyKey = allKeys.some((k) => parseProviderSecretKey(k) !== null);
    return { needsSetup: false, needsUnlock: false, needsApiKey: !hasAnyKey };
  });

  // Codex OAuth handlers
  ipcMain.handle('codex:startOAuth', async (_event, keyName: string) => {
    try {
      const result = await startCodexOAuth((url) => shell.openExternal(url));
      if (!result) {
        return { success: false, error: 'OAuth flow was cancelled or timed out' };
      }
      const store = getSecretStore();
      await store.set(providerSecretKey('openai', keyName), result.accessToken);
      await store.set(`openai-codex-refresh:${keyName}`, result.refreshToken);
      await store.set(`openai-codex-expires:${keyName}`, String(result.expiresAt));

      // Push credentials to running deployments
      pushCredentialsToRunningDeployments()
        .then((pushResult) => {
          if (pushResult.failed.length > 0) {
            const win = getWindow();
            if (win && !win.isDestroyed()) {
              win.webContents.send('credentials:pushFailed', pushResult.failed);
            }
          }
        })
        .catch((err) => console.error('[codex-auth] Credential push error:', err));
      getModelCache()
        .refresh()
        .catch(() => {});

      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[codex-auth] OAuth error:', message);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('codex:refreshToken', async (_event, keyName: string) => {
    try {
      const store = getSecretStore();
      const refreshToken = await store.get(`openai-codex-refresh:${keyName}`);
      if (!refreshToken) {
        return { success: false, error: 'No Codex refresh token found' };
      }
      const result = await refreshCodexToken(refreshToken);
      if (!result) {
        return { success: false, error: 'Token refresh failed' };
      }
      await store.set(providerSecretKey('openai', keyName), result.accessToken);
      await store.set(`openai-codex-refresh:${keyName}`, result.refreshToken);
      await store.set(`openai-codex-expires:${keyName}`, String(result.expiresAt));

      pushCredentialsToRunningDeployments().catch(() => {});
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  });

  // Claude OAuth handlers (two-step manual flow)
  ipcMain.handle('claude:prepareOAuth', async () => {
    const flow = await prepareClaudeOAuth();
    await shell.openExternal(flow.authorizeUrl);
    return flow;
  });

  ipcMain.handle(
    'claude:completeOAuth',
    async (_event, keyName: string, code: string, state: string, verifier: string) => {
      try {
        const apiKey = await completeClaudeOAuth(code, state, verifier);
        if (!apiKey) {
          return { success: false, error: 'Failed to create API key' };
        }
        const store = getSecretStore();
        await store.set(providerSecretKey('anthropic', keyName), apiKey);
        await store.set(`anthropic-oauth-marker:${keyName}`, '1');

        pushCredentialsToRunningDeployments()
          .then((pushResult) => {
            if (pushResult.failed.length > 0) {
              const win = getWindow();
              if (win && !win.isDestroyed()) {
                win.webContents.send('credentials:pushFailed', pushResult.failed);
              }
            }
          })
          .catch((err) => console.error('[claude-auth] Credential push error:', err));
        getModelCache()
          .refresh()
          .catch(() => {});

        return { success: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[claude-auth] OAuth error:', message);
        return { success: false, error: message };
      }
    },
  );

  // Chat handlers
  ipcMain.handle('chat:listConversations', (_event, deploymentId: string) =>
    getChatService(getWindow).listConversations(deploymentId),
  );
  ipcMain.handle('chat:listAllConversations', () =>
    getChatService(getWindow).listAllConversations(),
  );
  ipcMain.handle('chat:createConversation', (_event, deploymentId: string, agentName: string) =>
    getChatService(getWindow).createConversation(deploymentId, agentName),
  );
  ipcMain.handle('chat:getMessages', (_event, conversationId: string) =>
    getChatService(getWindow).getMessages(conversationId),
  );
  ipcMain.handle('chat:renameConversation', (_event, conversationId: string, title: string) =>
    getChatService(getWindow).renameConversation(conversationId, title),
  );
  ipcMain.handle('chat:deleteConversation', (_event, conversationId: string) =>
    getChatService(getWindow).deleteConversation(conversationId),
  );
  ipcMain.handle(
    'chat:sendMessage',
    (
      _event,
      conversationId: string,
      text: string,
      images?: { mediaType: string; data: string }[],
    ) => getChatService(getWindow).sendMessage(conversationId, text, images),
  );
  ipcMain.handle('chat:cancel', (_event, conversationId: string) => {
    getChatService(getWindow).cancel(conversationId);
  });
  ipcMain.handle(
    'chat:answer-question',
    (_event, conversationId: string, questionId: string, answer: string) =>
      getChatService(getWindow).answerQuestion(conversationId, questionId, answer),
  );

  // Secrets handlers
  ipcMain.handle('secrets:needsSetup', async () => {
    return getSecretStore().needsSetup();
  });

  ipcMain.handle('secrets:needsMigration', async () => {
    return getSecretStore().needsMigration();
  });

  ipcMain.handle('secrets:isUnlocked', () => {
    return getSecretStore().isUnlocked();
  });

  ipcMain.handle('secrets:setup', async (_event, password: string) => {
    const store = getSecretStore();
    const key = await store.setup(password);
    cacheKey(key);
  });

  ipcMain.handle('secrets:unlock', async (_event, password: string) => {
    const store = getSecretStore();
    const key = await store.unlockWithPassword(password);
    cacheKey(key);
    // Register running deployments now that secrets are available
    const deployments = await getRegistry().list();
    for (const dep of deployments.filter((d) => d.status === 'running')) {
      try {
        await rt.registerWithGateway(dep.id);
      } catch (err) {
        console.error(`Failed to register deployment ${dep.id} after unlock:`, err);
      }
    }
  });

  ipcMain.handle('secrets:lock', () => {
    getSecretStore().lock();
    clearCachedKey();
  });

  ipcMain.handle('secrets:list', async () => {
    return getSecretStore().list();
  });

  ipcMain.handle('secrets:get', async (_event, key: string) => {
    return getSecretStore().get(key);
  });

  ipcMain.handle('secrets:set', async (_event, key: string, value: string) => {
    await getSecretStore().set(key, value);
    // Push updated credentials to running deployments if a provider key changed
    if (key.includes('-api-key:')) {
      pushCredentialsToRunningDeployments()
        .then((result) => {
          if (result.failed.length > 0) {
            const win = getWindow();
            if (win && !win.isDestroyed()) {
              win.webContents.send('credentials:pushFailed', result.failed);
            }
          }
        })
        .catch((err) => {
          console.error('[credentials] Unexpected error during push:', err);
        });
      getModelCache()
        .refresh()
        .catch(() => {});
    }
  });

  ipcMain.handle('secrets:delete', async (_event, key: string) => {
    await getSecretStore().delete(key);
    // Push updated credentials to running deployments if a provider key changed
    if (key.includes('-api-key:')) {
      pushCredentialsToRunningDeployments()
        .then((result) => {
          if (result.failed.length > 0) {
            const win = getWindow();
            if (win && !win.isDestroyed()) {
              win.webContents.send('credentials:pushFailed', result.failed);
            }
          }
        })
        .catch((err) => {
          console.error('[credentials] Unexpected error during push:', err);
        });
      getModelCache()
        .refresh()
        .catch(() => {});
    }
  });

  // Deployment handlers
  ipcMain.handle('deployments:list', async () => {
    const deployments = await getRegistry().list();
    // Resolve live runtime status for deployments that claim to be running,
    // since the persisted status can be stale after MC restart or agent crash.
    const resolved = await Promise.all(
      deployments.map(async (dep) => {
        if (dep.status !== 'running' && dep.status !== 'provisioning') return dep;
        try {
          const rs = await getRuntime().getStatus(dep.id);
          const mapped = rs.state === 'starting' ? 'provisioning' : rs.state;
          return mapped !== dep.status ? { ...dep, status: mapped as typeof dep.status } : dep;
        } catch {
          return dep;
        }
      }),
    );
    return resolved;
  });

  ipcMain.handle('deployments:get', async (_event, id: string) => {
    return getRegistry().get(id);
  });

  ipcMain.handle('deployments:getAgentConfig', async (_event, agentName: string) => {
    const gatewayState = await new GatewayStateStore(DATA_DIR).read();
    if (!gatewayState) throw new Error('Gateway not running');
    const client = new GatewayManagementClient(
      `http://127.0.0.1:${gatewayState.port}`,
      gatewayState.token,
    );
    return client.getRuntimeAgent(agentName);
  });

  ipcMain.handle('deployments:deploy', async (_event, configDir: string) => {
    let deploymentId: string;
    try {
      deploymentId = await getRuntime().deploy(configDir);
    } catch (err) {
      if (err instanceof DeploymentStartupError) {
        deploymentId = err.deploymentId;
      } else {
        throw err;
      }
    }
    return deploymentId;
  });

  ipcMain.handle(
    'deployments:deployWithConfig',
    async (_event, options: DeployWithConfigOptions) => {
      const { name, model, fallbackModels, systemPrompt, tools, workspace, mcpServers } = options;

      // Create a temp config directory with the agent and gateway config
      const configDir = join(tmpdir(), `mc-deploy-${Date.now()}`);
      const agentsDir = join(configDir, 'agents');
      await mkdir(agentsDir, { recursive: true });

      // Write agent config
      const agentConfig = {
        name,
        model,
        fallbackModels: fallbackModels && fallbackModels.length > 0 ? fallbackModels : undefined,
        systemPrompt,
        tools: tools.length > 0 ? tools : undefined,
        ...(workspace ? { workspace } : {}),
        ...(mcpServers && mcpServers.length > 0 ? { mcpServers } : {}),
      };
      await writeFile(join(agentsDir, `${name}.json`), JSON.stringify(agentConfig, null, 2));

      let deploymentId: string;
      try {
        deploymentId = await getRuntime().deploy(configDir);
      } catch (err) {
        if (err instanceof DeploymentStartupError) {
          deploymentId = err.deploymentId;
        } else {
          throw err;
        }
      }
      return deploymentId;
    },
  );

  ipcMain.handle('deployments:stop', async (_event, id: string) => {
    await getRuntime().stop(id);
    const win = getWindow();
    if (win) {
      win.webContents.send('deployment:statusChange', id, 'stopped');
    }
  });

  ipcMain.handle('deployments:restart', async (_event, id: string) => {
    await getRuntime().start(id);
    const dep = await getRegistry().get(id);
    const win = getWindow();
    if (win) {
      win.webContents.send('deployment:statusChange', id, dep?.status ?? 'running');
    }
  });

  ipcMain.handle('deployments:remove', async (_event, id: string, deleteWorkspace?: boolean) => {
    // Cancel any active log subscription
    const sub = logSubscriptions.get(id);
    if (sub) {
      sub.abort();
      logSubscriptions.delete(id);
    }

    if (deleteWorkspace) {
      const deployment = await getRegistry().get(id);
      if (deployment?.workspace) {
        await rm(deployment.workspace, { recursive: true, force: true });
      }
    }

    await getRuntime().remove(id);
    const win = getWindow();
    if (win) {
      win.webContents.send('deployment:statusChange', id, 'removed');
    }
  });

  ipcMain.handle('deployments:getStatus', async (_event, id: string) => {
    return getRuntime().getStatus(id);
  });

  ipcMain.handle('deployments:getChannelHealth', async (_event, id: string) => {
    const deployment = await getRegistry().get(id);
    if (!deployment || deployment.status !== 'running') {
      return [];
    }
    // Channel health is monitored by the gateway; return empty for now
    return [];
  });

  ipcMain.handle('deployments:logs:subscribe', async (_event, id: string) => {
    // Cancel existing subscription for this ID
    const existing = logSubscriptions.get(id);
    if (existing) {
      existing.abort();
    }

    const controller = new AbortController();
    logSubscriptions.set(id, controller);

    // Start iterating logs in the background
    (async () => {
      try {
        const logs = getRuntime().getLogs(id, controller.signal);
        for await (const line of logs) {
          if (controller.signal.aborted) break;
          const win = getWindow();
          if (win && !win.isDestroyed()) {
            win.webContents.send('deployment:log', id, line);
          } else {
            break;
          }
        }
      } catch {
        // Deployment may not have active processes
      } finally {
        logSubscriptions.delete(id);
      }
    })();
  });

  ipcMain.handle('deployments:logs:unsubscribe', async (_event, id: string) => {
    const sub = logSubscriptions.get(id);
    if (sub) {
      sub.abort();
      logSubscriptions.delete(id);
    }
  });

  // Messaging Apps handlers
  ipcMain.handle('messagingApps:list', async () => {
    return getMessagingAppRegistry().list();
  });

  ipcMain.handle('messagingApps:get', async (_event, id: string) => {
    return getMessagingAppRegistry().get(id);
  });

  ipcMain.handle(
    'messagingApps:create',
    async (
      _event,
      app: Omit<MessagingApp, 'id' | 'createdAt' | 'credentialsKey'>,
      token: string,
    ) => {
      const registry = getMessagingAppRegistry();
      const secretStore = getSecretStore();
      const id = randomUUID().slice(0, 8);
      const created: MessagingApp = {
        ...app,
        id,
        credentialsKey: '',
        createdAt: new Date().toISOString(),
      };
      await registry.add(created);
      const credKey = `messaging-app:${id}:token`;
      try {
        await secretStore.set(credKey, token);
      } catch (err) {
        await registry.remove(id).catch(() => {});
        throw err;
      }
      await registry.update(id, { credentialsKey: credKey });
      return { ...created, credentialsKey: credKey };
    },
  );

  ipcMain.handle(
    'messagingApps:update',
    async (_event, id: string, patch: Partial<MessagingApp>) => {
      return getMessagingAppRegistry().update(id, patch);
    },
  );

  ipcMain.handle('messagingApps:delete', async (_event, id: string) => {
    const app = await getMessagingAppRegistry().get(id);
    if (app) {
      if (app.type === 'whatsapp') {
        // Clean up all namespaced auth keys
        const secretStore = getSecretStore();
        const prefix = `${app.credentialsKey}:`;
        const allKeys = await secretStore.list();
        for (const key of allKeys.filter((k) => k.startsWith(prefix))) {
          await secretStore.delete(key);
        }
        // Clean up runtime auth state directory
        const { homedir } = await import('node:os');
        const { rm } = await import('node:fs/promises');
        const authStateDir = join(DATA_DIR, 'whatsapp-sessions', id);
        await rm(authStateDir, { recursive: true, force: true });
      } else {
        await getSecretStore().delete(app.credentialsKey);
      }
    }
    return getMessagingAppRegistry().remove(id);
  });

  ipcMain.handle('messagingApps:verifyTelegramToken', async (_event, token: string) => {
    const response = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    if (!response.ok) {
      throw new Error(`Telegram API error: ${response.status} ${response.statusText}`);
    }
    const data = (await response.json()) as {
      ok: boolean;
      description?: string;
      result?: { username: string; first_name: string };
    };
    if (!data.ok) {
      throw new Error(data.description ?? 'Invalid token');
    }
    if (!data.result) {
      throw new Error('Unexpected response from Telegram API');
    }
    return { username: data.result.username, firstName: data.result.first_name };
  });

  ipcMain.handle('whatsapp:startPairing', async (_event, appId: string) => {
    const store = getSecretStore();
    const prefix = `whatsapp-auth:${appId}:`;

    // Wrap store with prefix for this pairing session
    const prefixedStore = {
      get: (key: string) => store.get(`${prefix}${key}`),
      set: (key: string, value: string) => store.set(`${prefix}${key}`, value),
      delete: (key: string) => store.delete(`${prefix}${key}`),
      list: async () => {
        const all = await store.list();
        return all.filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
      },
    };

    const { startWhatsAppPairing } = await import('@dash/channels');
    const qrcode = await import('qrcode');

    await startWhatsAppPairing(prefixedStore, {
      onQr: (qrString) => {
        try {
          qrcode.default.toDataURL(qrString).then((qrDataUrl) => {
            const win = getWindow();
            win?.webContents.send('whatsapp:qr', appId, qrDataUrl);
          });
        } catch {
          // QR generation failed silently
        }
      },
      onLinked: () => {
        const win = getWindow();
        win?.webContents.send('whatsapp:linked', appId);
      },
      onError: (message) => {
        const win = getWindow();
        win?.webContents.send('whatsapp:error', appId, message);
      },
    });
  });

  ipcMain.handle(
    'messagingApps:createWhatsApp',
    async (
      _event,
      appId: string,
      app: Omit<MessagingApp, 'id' | 'createdAt' | 'credentialsKey'>,
    ) => {
      const registry = getMessagingAppRegistry();
      const credentialsKey = `whatsapp-auth:${appId}`;
      const created: MessagingApp = {
        ...app,
        id: appId,
        credentialsKey,
        createdAt: new Date().toISOString(),
      };
      await registry.add(created);
      return created;
    },
  );

  // Skills
  ipcMain.handle('skills:list', async (_e, deploymentId: string, agentName: string) =>
    (await getSkillsClient(deploymentId)).skills(agentName),
  );
  ipcMain.handle(
    'skills:get',
    async (_e, deploymentId: string, agentName: string, skillName: string) => {
      try {
        return await (await getSkillsClient(deploymentId)).skill(agentName, skillName);
      } catch (err) {
        if (err instanceof Error && err.message.includes('404')) return null;
        throw err;
      }
    },
  );
  ipcMain.handle(
    'skills:updateContent',
    async (_e, deploymentId: string, agentName: string, skillName: string, content: string) =>
      (await getSkillsClient(deploymentId)).updateSkillContent(agentName, skillName, content),
  );
  ipcMain.handle(
    'skills:create',
    async (
      _e,
      deploymentId: string,
      agentName: string,
      name: string,
      description: string,
      content: string,
    ) => (await getSkillsClient(deploymentId)).createSkill(agentName, name, description, content),
  );
  ipcMain.handle('skills:getConfig', async (_e, deploymentId: string, agentName: string) =>
    (await getSkillsClient(deploymentId)).skillsConfig(agentName),
  );
  ipcMain.handle(
    'skills:updateConfig',
    async (_e, deploymentId: string, agentName: string, config: SkillsConfig) =>
      (await getSkillsClient(deploymentId)).updateSkillsConfig(agentName, config),
  );

  // Deployment config update
  ipcMain.handle(
    'deployments:updateConfig',
    async (
      _event,
      id: string,
      patch: {
        name?: string;
        model?: string;
        fallbackModels?: string[];
        tools?: string[];
        systemPrompt?: string;
        mcpServers?: string[];
      },
    ) => {
      await getRuntime().updateAgentConfig(id, patch);
    },
  );

  // Settings handlers
  ipcMain.handle('settings:get', async () => {
    return getSettingsStore().get();
  });

  ipcMain.handle(
    'settings:set',
    async (_event, patch: { defaultModel?: string; defaultFallbackModels?: string[] }) => {
      await getSettingsStore().set(patch);
    },
  );

  ipcMain.handle('gateway:getStatus', () => {
    return gatewayPoller?.getCurrentStatus() ?? 'starting';
  });

  // Models
  ipcMain.handle('models:list', async () => {
    return getModelCache().load();
  });

  ipcMain.handle('models:refresh', async () => {
    const apiKeys = await getProviderApiKeys();
    return getModelCache().refresh(apiKeys);
  });

  ipcMain.handle('tools:list', async () => {
    return getModelCache().loadTools();
  });

  // --- MCP Connectors ---

  async function getMcpClient(): Promise<ManagementClient> {
    const gatewayState = await new GatewayStateStore(DATA_DIR).read();
    if (!gatewayState) {
      throw new Error('Gateway not running — Connectors unavailable');
    }
    return new ManagementClient(`http://127.0.0.1:${gatewayState.port}`, gatewayState.token);
  }

  ipcMain.handle('mcp:listConnectors', async () => {
    const client = await getMcpClient();
    return client.mcpListServers();
  });

  ipcMain.handle('mcp:getConnector', async (_e, name: string) => {
    const client = await getMcpClient();
    return client.mcpGetServer(name);
  });

  ipcMain.handle('mcp:addConnector', async (_e, config) => {
    const client = await getMcpClient();
    return client.mcpAddServer(config);
  });

  ipcMain.handle('mcp:removeConnector', async (_e, name: string) => {
    const client = await getMcpClient();
    return client.mcpRemoveServer(name);
  });

  ipcMain.handle('mcp:reconnectConnector', async (_e, name: string) => {
    const client = await getMcpClient();
    return client.mcpReconnectServer(name);
  });

  ipcMain.handle('mcp:getAllowlist', async () => {
    const client = await getMcpClient();
    return client.mcpGetAllowlist();
  });

  ipcMain.handle('mcp:setAllowlist', async (_e, patterns: string[]) => {
    const client = await getMcpClient();
    return client.mcpSetAllowlist(patterns);
  });

  // Background model cache refresh on startup
  getProviderApiKeys()
    .then((apiKeys) => getModelCache().refresh(apiKeys))
    .catch((err) => {
      console.warn(
        'Background model cache refresh failed:',
        err instanceof Error ? err.message : err,
      );
    });

  app.on('before-quit', async () => {
    gatewayPoller?.stop();
    // Kill gateway so next MC launch spawns a fresh one (picks up code changes)
    const gatewayState = await new GatewayStateStore(DATA_DIR).read();
    if (gatewayState) {
      try {
        process.kill(gatewayState.pid, 'SIGTERM');
      } catch {
        // Already dead
      }
      await new GatewayStateStore(DATA_DIR).clear();
    }
  });
}
