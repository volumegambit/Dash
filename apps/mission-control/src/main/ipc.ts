import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ManagementClient } from '@dash/management';
import {
  AgentRegistry,
  ConversationStore,
  DeploymentStartupError,
  EncryptedSecretStore,
  GatewayOptions,
  MessagingAppRegistry,
  ModelCacheService,
  ProcessRuntime,
  SettingsStore,
  defaultProcessSpawner,
  getPlatformDataDir,
  parseProviderSecretKey,
} from '@dash/mc';
import type { MessagingApp, ProcessSpawner } from '@dash/mc';
import { app, dialog, ipcMain, safeStorage, shell } from 'electron';
import type { BrowserWindow } from 'electron';
import type { DeployWithConfigOptions } from '../shared/ipc.js';
import { ChatService } from './chat-service.js';
import { GatewayPoller } from './gateway-poller.js';
import { HealthPoller } from './health-poller.js';

const DATA_DIR = process.env.MC_DATA_DIR || getPlatformDataDir('dash');
const SESSION_KEY_PATH = join(DATA_DIR, 'session.key');

let chatService: ChatService | undefined;
let secretStore: EncryptedSecretStore | undefined;
let registry: AgentRegistry | undefined;
let runtime: ProcessRuntime | undefined;
let messagingAppRegistry: MessagingAppRegistry | undefined;
let gatewayPoller: GatewayPoller | undefined;
let modelCache: ModelCacheService | undefined;
const healthPoller = new HealthPoller();

function getModelCache(): ModelCacheService {
  if (!modelCache) {
    modelCache = new ModelCacheService(DATA_DIR);
  }
  return modelCache;
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

  const allKeys = await store.list();
  const providerApiKeys: Record<string, Record<string, string>> = {};
  for (const key of allKeys) {
    const parsed = parseProviderSecretKey(key);
    if (!parsed) continue;
    const value = await store.get(key);
    if (!value) continue;
    if (!providerApiKeys[parsed.provider]) {
      providerApiKeys[parsed.provider] = {};
    }
    providerApiKeys[parsed.provider][parsed.keyName] = value;
  }

  const reg = getRegistry();
  const deployments = await reg.list();
  const running = deployments.filter(
    (dep) => dep.status === 'running' && dep.managementPort && dep.managementToken,
  );

  const result: CredentialPushResult = { total: running.length, succeeded: 0, failed: [] };

  for (const dep of running) {
    try {
      const client = new ManagementClient(
        `http://127.0.0.1:${dep.managementPort}`,
        dep.managementToken!,
      );
      await client.updateCredentials(providerApiKeys);
      result.succeeded++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[credentials] Failed to push to deployment "${dep.name}" (${dep.id}): ${message}`,
      );
      result.failed.push({ deploymentId: dep.id, name: dep.name, error: message });
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

  // Start gateway health poller
  const sendGatewayStatus = (status: string) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send('gateway:status', status);
  };
  gatewayPoller = new GatewayPoller(
    () => rt.ensureGateway(),
    async () => {
      const deployments = await getRegistry().list();
      for (const dep of deployments.filter((d) => d.status === 'running')) {
        try {
          await rt.registerWithGateway(dep.id);
        } catch (err) {
          console.error(`Failed to re-register deployment ${dep.id} after gateway restart:`, err);
        }
      }
    },
  );
  gatewayPoller.start(sendGatewayStatus);

  // Start health pollers for existing running deployments so status changes
  // are detected after MC restart (pollers are normally only started at deploy time).
  const existingDeployments = await getRegistry().list();
  for (const dep of existingDeployments) {
    if (dep.status === 'running' && dep.managementPort && dep.managementToken) {
      healthPoller.start(dep.id, dep.managementPort, dep.managementToken, (status) => {
        const win = getWindow();
        if (win && !win.isDestroyed()) {
          win.webContents.send('deployment:statusChange', dep.id, status);
        }
      });
    }
  }

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

  ipcMain.handle('app:getVersion', () => app.getVersion());

  // Shell
  ipcMain.handle('openExternal', async (_event, url: string) => {
    await shell.openExternal(url);
  });

  ipcMain.handle('openPath', async (_event, path: string) => {
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
    const hasAnyKey = allKeys.some(
      (k) =>
        k.startsWith('anthropic-api-key:') ||
        k.startsWith('openai-api-key:') ||
        k.startsWith('google-api-key:'),
    );
    return { needsSetup: false, needsUnlock: false, needsApiKey: !hasAnyKey };
  });

  // Chat handlers
  ipcMain.handle('chat:listConversations', (_event, deploymentId: string) =>
    getChatService(getWindow).listConversations(deploymentId),
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
    const dep = await getRegistry().get(deploymentId);
    if (dep?.managementPort && dep?.managementToken) {
      healthPoller.start(deploymentId, dep.managementPort, dep.managementToken, (status) => {
        const win = getWindow();
        if (win && !win.isDestroyed()) {
          win.webContents.send('deployment:statusChange', deploymentId, status);
        }
      });
    }
    return deploymentId;
  });

  ipcMain.handle(
    'deployments:deployWithConfig',
    async (_event, options: DeployWithConfigOptions) => {
      const { name, model, fallbackModels, systemPrompt, tools, workspace } = options;

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
      const dep = await getRegistry().get(deploymentId);
      if (dep?.managementPort && dep?.managementToken) {
        healthPoller.start(deploymentId, dep.managementPort, dep.managementToken, (status) => {
          const win = getWindow();
          if (win && !win.isDestroyed()) {
            win.webContents.send('deployment:statusChange', deploymentId, status);
          }
        });
      }
      return deploymentId;
    },
  );

  ipcMain.handle('deployments:stop', async (_event, id: string) => {
    healthPoller.stop(id);
    await getRuntime().stop(id);
    const win = getWindow();
    if (win) {
      win.webContents.send('deployment:statusChange', id, 'stopped');
    }
  });

  ipcMain.handle('deployments:restart', async (_event, id: string) => {
    healthPoller.stop(id);
    await getRuntime().start(id);
    const dep = await getRegistry().get(id);
    if (dep?.managementPort && dep?.managementToken) {
      healthPoller.start(id, dep.managementPort, dep.managementToken, (status) => {
        const win = getWindow();
        if (win && !win.isDestroyed()) {
          win.webContents.send('deployment:statusChange', id, status);
        }
      });
    }
    const win = getWindow();
    if (win) {
      win.webContents.send('deployment:statusChange', id, dep?.status ?? 'running');
    }
  });

  ipcMain.handle('deployments:remove', async (_event, id: string, deleteWorkspace?: boolean) => {
    healthPoller.stop(id);

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
    if (!deployment || !deployment.managementPort) {
      return [];
    }
    try {
      const client = new ManagementClient(
        `http://127.0.0.1:${deployment.managementPort}`,
        deployment.managementToken ?? '',
      );
      return await client.getChannelHealth();
    } catch {
      return [];
    }
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

  // Deployment config update
  ipcMain.handle(
    'deployments:updateConfig',
    async (
      _event,
      id: string,
      patch: { model?: string; fallbackModels?: string[]; tools?: string[]; systemPrompt?: string },
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
    return getModelCache().refresh();
  });

  ipcMain.handle('tools:list', async () => {
    return getModelCache().loadTools();
  });

  // Background model cache refresh on startup
  getModelCache()
    .refresh()
    .catch((err) => {
      console.warn(
        'Background model cache refresh failed:',
        err instanceof Error ? err.message : err,
      );
    });

  app.on('before-quit', () => {
    healthPoller.stopAll();
  });
}
