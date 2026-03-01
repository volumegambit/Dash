import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { EncryptedSecretStore } from '@dash/mc';
import { app, ipcMain, safeStorage } from 'electron';
import type { BrowserWindow } from 'electron';

const DATA_DIR = join(homedir(), '.mission-control');
const SESSION_KEY_PATH = join(DATA_DIR, 'session.key');

let ws: WebSocket | undefined;
let secretStore: EncryptedSecretStore | undefined;

function getSecretStore(): EncryptedSecretStore {
  if (!secretStore) {
    secretStore = new EncryptedSecretStore(DATA_DIR);
  }
  return secretStore;
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

  // Chat handlers
  ipcMain.handle('chat:connect', (_event, gatewayUrl: string) => {
    if (ws) {
      ws.close();
      ws = undefined;
    }

    ws = new WebSocket(gatewayUrl);

    ws.addEventListener('message', (event) => {
      const win = getWindow();
      if (!win) return;

      try {
        const msg = JSON.parse(String(event.data)) as {
          type: string;
          conversationId: string;
          text?: string;
          error?: string;
        };

        if (msg.type === 'response') {
          win.webContents.send('chat:response', msg.conversationId, msg.text ?? '');
        } else if (msg.type === 'error') {
          win.webContents.send('chat:error', msg.conversationId, msg.error ?? 'Unknown error');
        }
      } catch {
        // Ignore malformed messages
      }
    });

    ws.addEventListener('error', () => {
      const win = getWindow();
      if (win) {
        win.webContents.send('chat:error', '', 'WebSocket connection error');
      }
    });
  });

  ipcMain.handle('chat:disconnect', () => {
    if (ws) {
      ws.close();
      ws = undefined;
    }
  });

  ipcMain.handle('chat:send', (_event, conversationId: string, text: string) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error('Not connected to gateway');
    }
    ws.send(JSON.stringify({ type: 'message', conversationId, text }));
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
}
