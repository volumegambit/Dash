import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  AgentRegistry,
  ConversationStore,
  EncryptedSecretStore,
  MessagingAppRegistry,
  ProcessRuntime,
  defaultProcessSpawner,
} from '@dash/mc';
import type { MessagingApp } from '@dash/mc';
import { app, dialog, ipcMain, safeStorage, shell } from 'electron';
import type { BrowserWindow } from 'electron';
import type { DeployWithConfigOptions } from '../shared/ipc.js';
import { ChatService } from './chat-service.js';

const DATA_DIR = join(homedir(), '.mission-control');
const SESSION_KEY_PATH = join(DATA_DIR, 'session.key');

let chatService: ChatService | undefined;
let secretStore: EncryptedSecretStore | undefined;
let registry: AgentRegistry | undefined;
let runtime: ProcessRuntime | undefined;
let messagingAppRegistry: MessagingAppRegistry | undefined;

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

function resolveProjectRoot(): string {
  if (process.env.DASH_PROJECT_ROOT) {
    return process.env.DASH_PROJECT_ROOT;
  }
  // Dev mode: __dirname is apps/mission-control/out/main — 4 levels up is the monorepo root.
  // Production: DASH_PROJECT_ROOT must be set (the monorepo layout doesn't exist in a packaged app).
  const candidate = resolve(__dirname, '../../../..');
  return candidate;
}

function getRuntime(): ProcessRuntime {
  if (!runtime) {
    runtime = new ProcessRuntime(
      getRegistry(),
      getSecretStore(),
      resolveProjectRoot(),
      defaultProcessSpawner,
      getMessagingAppRegistry(),
    );
  }
  return runtime;
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
      return { needsSetup: true, needsApiKey: true };
    }
    if (!store.isUnlocked()) {
      // Secrets exist but are locked — still need setup flow (unlock first)
      return { needsSetup: true, needsApiKey: false };
    }
    const apiKey = await store.get('anthropic-api-key');
    return { needsSetup: false, needsApiKey: !apiKey };
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
    return getRuntime().deploy(configDir);
  });

  ipcMain.handle(
    'deployments:deployWithConfig',
    async (_event, options: DeployWithConfigOptions) => {
      const { name, model, systemPrompt, tools, enableTelegram, workspace } = options;

      // Create a temp config directory with the agent and gateway config
      const configDir = join(tmpdir(), `mc-deploy-${Date.now()}`);
      const agentsDir = join(configDir, 'agents');
      await mkdir(agentsDir, { recursive: true });

      // Write agent config
      const agentConfig = {
        name,
        model,
        systemPrompt,
        tools: tools.length > 0 ? tools : undefined,
        ...(workspace ? { workspace } : {}),
      };
      await writeFile(join(agentsDir, `${name}.json`), JSON.stringify(agentConfig, null, 2));

      // Write gateway config if telegram is enabled
      if (enableTelegram) {
        const gatewayConfig = {
          channels: {
            telegram: {
              adapter: 'telegram',
              agent: name,
            },
          },
        };
        await writeFile(join(configDir, 'gateway.json'), JSON.stringify(gatewayConfig, null, 2));
      }

      return getRuntime().deploy(configDir);
    },
  );

  ipcMain.handle('deployments:stop', async (_event, id: string) => {
    await getRuntime().stop(id);
    const win = getWindow();
    if (win) {
      win.webContents.send('deployment:statusChange', id, 'stopped');
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

  ipcMain.handle('messagingApps:create', async (_event, app: Omit<MessagingApp, 'id' | 'createdAt'>) => {
    const id = randomUUID().slice(0, 8);
    const newApp: MessagingApp = {
      ...app,
      id,
      createdAt: new Date().toISOString(),
    };
    await getMessagingAppRegistry().add(newApp);
    return newApp;
  });

  ipcMain.handle('messagingApps:update', async (_event, id: string, patch: Partial<MessagingApp>) => {
    return getMessagingAppRegistry().update(id, patch);
  });

  ipcMain.handle('messagingApps:delete', async (_event, id: string) => {
    const app = await getMessagingAppRegistry().get(id);
    if (app) {
      // Delete credential from secret store first (before removing from registry),
      // so the registry never points to a missing credential.
      // Note: this is not atomic — if the registry remove fails after secret deletion,
      // the entry will remain in the registry with a missing credential.
      //
      // Best-effort credential cleanup: if the secret is already gone, that's fine.
      // Note: if the store is locked, this will throw, which is the right behaviour —
      // we should not delete the registry entry if we can't clean up credentials.
      await getSecretStore().delete(app.credentialsKey);
    }
    return getMessagingAppRegistry().remove(id);
  });

  ipcMain.handle('messagingApps:verifyTelegramToken', async (_event, token: string) => {
    const response = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const data = await response.json() as { ok: boolean; description?: string; result?: { username: string; first_name: string } };
    if (!data.ok) {
      throw new Error(data.description ?? 'Invalid token');
    }
    return { username: data.result!.username, firstName: data.result!.first_name };
  });
}
