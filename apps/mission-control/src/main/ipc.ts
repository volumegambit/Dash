import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ManagementClient, type SkillsConfig } from '@dash/management';
import {
  AgentRegistry,
  ConversationStore,
  DeploymentStartupError,
  EncryptedSecretStore,
  MessagingAppRegistry,
  ProcessRuntime,
  SettingsStore,
  defaultProcessSpawner,
} from '@dash/mc';
import type { MessagingApp, ProcessSpawner } from '@dash/mc';
import { app, dialog, ipcMain, safeStorage, shell } from 'electron';
import type { BrowserWindow } from 'electron';
import type { DeployWithConfigOptions } from '../shared/ipc.js';
import { ChatService } from './chat-service.js';
import { HealthPoller } from './health-poller.js';

const DATA_DIR = process.env.MC_DATA_DIR || join(homedir(), '.mission-control');
const SESSION_KEY_PATH = join(DATA_DIR, 'session.key');

let chatService: ChatService | undefined;
let secretStore: EncryptedSecretStore | undefined;
let registry: AgentRegistry | undefined;
let runtime: ProcessRuntime | undefined;
let messagingAppRegistry: MessagingAppRegistry | undefined;
const healthPoller = new HealthPoller();

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
    );
  }
  return runtime;
}

function getSettingsStore(): SettingsStore {
  return new SettingsStore(DATA_DIR);
}

async function getSkillsClient(deploymentId: string) {
  const dep = await getRegistry().get(deploymentId);
  if (!dep?.managementPort || !dep?.managementToken) {
    throw new Error('Deployment not running or Management API not available');
  }
  return new ManagementClient(`http://127.0.0.1:${dep.managementPort}`, dep.managementToken);
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

export async function registerIpcHandlers(
  getWindow: () => BrowserWindow | undefined,
): Promise<void> {
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
    const anthropicKey = await store.get('anthropic-api-key');
    const openaiKey = await store.get('openai-api-key');
    const googleKey = await store.get('google-api-key');
    const hasAnyKey = !!(anthropicKey || openaiKey || googleKey);
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
  ipcMain.handle('chat:deleteConversation', (_event, conversationId: string) =>
    getChatService(getWindow).deleteConversation(conversationId),
  );
  ipcMain.handle('chat:sendMessage', (_event, conversationId: string, text: string) =>
    getChatService(getWindow).sendMessage(conversationId, text),
  );
  ipcMain.handle('chat:cancel', (_event, conversationId: string) => {
    getChatService(getWindow).cancel(conversationId);
  });

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
    return getSecretStore().set(key, value);
  });

  ipcMain.handle('secrets:delete', async (_event, key: string) => {
    return getSecretStore().delete(key);
  });

  // Deployment handlers
  ipcMain.handle('deployments:list', async () => {
    return getRegistry().list();
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
    async (_event, id: string, patch: { model?: string; fallbackModels?: string[] }) => {
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

  app.on('before-quit', () => {
    healthPoller.stopAll();
  });
}
