import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { SkillsConfig } from '@dash/management';
import { ManagementClient } from '@dash/management';
import {
  ConversationStore,
  GatewayManagementClient,
  GatewayProcess,
  GatewayStateStore,
  ModelCacheService,
  SettingsStore,
  defaultProcessSpawner,
  getPlatformDataDir,
} from '@dash/mc';
import type { CreateAgentRequest, GatewayChannel, GatewayProcessOptions, ProcessSpawner } from '@dash/mc';
import { app, dialog, ipcMain, shell } from 'electron';
import type { BrowserWindow } from 'electron';
import { ChatService } from './chat-service.js';
import { completeClaudeOAuth, prepareClaudeOAuth } from './claude-auth.js';
import { refreshCodexToken, startCodexOAuth } from './codex-auth.js';
import { GatewayPoller } from './gateway-poller.js';

const DATA_DIR = process.env.MC_DATA_DIR || getPlatformDataDir('dash');

let chatService: ChatService | undefined;
let gatewayPoller: GatewayPoller | undefined;
let modelCache: ModelCacheService | undefined;
let gatewayProcess: GatewayProcess | undefined;

function getModelCache(): ModelCacheService {
  if (!modelCache) {
    modelCache = new ModelCacheService(DATA_DIR);
  }
  return modelCache;
}

function getGatewayProcess(options: GatewayProcessOptions): GatewayProcess {
  if (!gatewayProcess) {
    gatewayProcess = new GatewayProcess(options);
  }
  return gatewayProcess;
}

async function getClient(gw: GatewayProcess): Promise<GatewayManagementClient> {
  return gw.ensureRunning();
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

function getSettingsStore(): SettingsStore {
  return new SettingsStore(DATA_DIR);
}

function getChatService(getWindow: () => BrowserWindow | undefined): ChatService {
  if (!chatService) {
    chatService = new ChatService(
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

async function getSkillsClient(): Promise<ManagementClient> {
  const gatewayState = await new GatewayStateStore(DATA_DIR).read();
  if (!gatewayState) {
    throw new Error('Gateway not running — Skills API unavailable');
  }
  return new ManagementClient(`http://127.0.0.1:${gatewayState.port}`, gatewayState.token);
}

export async function registerIpcHandlers(
  getWindow: () => BrowserWindow | undefined,
): Promise<void> {
  const gwOptions: GatewayProcessOptions = {
    gatewayDataDir: DATA_DIR,
    gatewayRuntimeDir: getPlatformDataDir('dash-gateway'),
    projectRoot: resolveProjectRoot(),
  };
  const gw = getGatewayProcess(gwOptions);

  // Start shared gateway
  try {
    await gw.ensureRunning();
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
  gatewayPoller = new GatewayPoller(() => gw.ensureRunning());

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

  gatewayPoller.start(
    (status: string) => {
      sendGatewayStatus(status);
      if (status === 'healthy') {
        connectToGatewayEvents().catch(() => {});
      }
    },
    (serverName: string, mcpStatus: string) => {
      const win = getWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send('mcp:statusChanged', { serverName, status: mcpStatus });
      }
    },
  );

  // -----------------------------------------------------------------------
  // App
  // -----------------------------------------------------------------------

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

  // -----------------------------------------------------------------------
  // Agents (gateway passthrough)
  // -----------------------------------------------------------------------

  ipcMain.handle('agents:list', async () => {
    const client = await getClient(gw);
    return client.listAgents();
  });

  ipcMain.handle('agents:get', async (_e, id: string) => {
    const client = await getClient(gw);
    return client.getAgent(id);
  });

  ipcMain.handle('agents:create', async (_e, config: CreateAgentRequest) => {
    const client = await getClient(gw);
    return client.createAgent(config);
  });

  ipcMain.handle('agents:update', async (_e, id: string, patch: Partial<CreateAgentRequest>) => {
    const client = await getClient(gw);
    return client.updateAgent(id, patch);
  });

  ipcMain.handle('agents:remove', async (_e, id: string) => {
    const client = await getClient(gw);
    await client.removeAgent(id);
  });

  ipcMain.handle('agents:disable', async (_e, id: string) => {
    const client = await getClient(gw);
    await client.disableAgent(id);
  });

  ipcMain.handle('agents:enable', async (_e, id: string) => {
    const client = await getClient(gw);
    await client.enableAgent(id);
  });

  // -----------------------------------------------------------------------
  // Channels (gateway passthrough)
  // -----------------------------------------------------------------------

  ipcMain.handle('channels:list', async () => {
    const client = await getClient(gw);
    return client.listChannels();
  });

  ipcMain.handle('channels:get', async (_e, name: string) => {
    const client = await getClient(gw);
    return client.getChannel(name);
  });

  ipcMain.handle(
    'channels:create',
    async (
      _e,
      config: {
        name: string;
        adapter: string;
        token?: string;
        globalDenyList?: string[];
        routing: GatewayChannel['routing'];
      },
    ) => {
      const client = await getClient(gw);
      // If token provided, store as credential first
      if (config.token) {
        await client.setCredential(`channel:${config.name}:token`, config.token);
      }
      await client.registerChannel({
        name: config.name,
        adapter: config.adapter,
        globalDenyList: config.globalDenyList ?? [],
        routing: config.routing,
      });
    },
  );

  ipcMain.handle(
    'channels:update',
    async (
      _e,
      name: string,
      patch: Partial<Pick<GatewayChannel, 'globalDenyList' | 'routing'>>,
    ) => {
      const client = await getClient(gw);
      await client.updateChannel(name, patch);
    },
  );

  ipcMain.handle('channels:remove', async (_e, name: string) => {
    const client = await getClient(gw);
    await client.removeChannel(name);
  });

  ipcMain.handle('channels:verifyTelegramToken', async (_e, token: string) => {
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

  // -----------------------------------------------------------------------
  // Credentials (gateway passthrough)
  // -----------------------------------------------------------------------

  ipcMain.handle('credentials:set', async (_e, key: string, value: string) => {
    const client = await getClient(gw);
    await client.setCredential(key, value);
    // Refresh model cache when a provider key changes
    getModelCache().refresh().catch(() => {});
  });

  ipcMain.handle('credentials:list', async () => {
    const client = await getClient(gw);
    return client.listCredentials();
  });

  ipcMain.handle('credentials:remove', async (_e, key: string) => {
    const client = await getClient(gw);
    await client.removeCredential(key);
    // Refresh model cache when a provider key changes
    getModelCache().refresh().catch(() => {});
  });

  // -----------------------------------------------------------------------
  // OAuth — Codex (OpenAI)
  // -----------------------------------------------------------------------

  ipcMain.handle('codex:startOAuth', async (_event, keyName: string) => {
    try {
      const result = await startCodexOAuth((url) => shell.openExternal(url));
      if (!result) {
        return { success: false, error: 'OAuth flow was cancelled or timed out' };
      }
      const client = await getClient(gw);
      await client.setCredential(`openai-api-key:${keyName}`, result.accessToken);
      await client.setCredential(`openai-codex-refresh:${keyName}`, result.refreshToken);
      await client.setCredential(`openai-codex-expires:${keyName}`, String(result.expiresAt));

      getModelCache().refresh().catch(() => {});
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[codex-auth] OAuth error:', message);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('codex:refreshToken', async (_event, keyName: string) => {
    try {
      const client = await getClient(gw);
      // Retrieve refresh token from gateway credentials
      // The gateway credentials API only lists keys, not values — so we store
      // the refresh token as a credential and retrieve it via a convention.
      // For now, the codex refresh flow requires the token to have been stored.
      const result = await refreshCodexToken(''); // TODO: retrieve refresh token from gateway
      if (!result) {
        return { success: false, error: 'Token refresh failed' };
      }
      await client.setCredential(`openai-api-key:${keyName}`, result.accessToken);
      await client.setCredential(`openai-codex-refresh:${keyName}`, result.refreshToken);
      await client.setCredential(`openai-codex-expires:${keyName}`, String(result.expiresAt));
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  });

  // -----------------------------------------------------------------------
  // OAuth — Claude (Anthropic)
  // -----------------------------------------------------------------------

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
        const client = await getClient(gw);
        await client.setCredential(`anthropic-api-key:${keyName}`, apiKey);

        getModelCache().refresh().catch(() => {});
        return { success: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[claude-auth] OAuth error:', message);
        return { success: false, error: message };
      }
    },
  );

  // -----------------------------------------------------------------------
  // Chat
  // -----------------------------------------------------------------------

  ipcMain.handle('chat:listConversations', () =>
    getChatService(getWindow).listConversations(),
  );

  ipcMain.handle('chat:createConversation', (_event, agentId: string) =>
    getChatService(getWindow).createConversation(agentId),
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

  // -----------------------------------------------------------------------
  // Skills (gateway passthrough)
  // -----------------------------------------------------------------------

  ipcMain.handle('skills:list', async (_e, agentId: string) =>
    (await getSkillsClient()).skills(agentId),
  );

  ipcMain.handle('skills:get', async (_e, agentId: string, skillName: string) => {
    try {
      return await (await getSkillsClient()).skill(agentId, skillName);
    } catch (err) {
      if (err instanceof Error && err.message.includes('404')) return null;
      throw err;
    }
  });

  ipcMain.handle(
    'skills:updateContent',
    async (_e, agentId: string, skillName: string, content: string) =>
      (await getSkillsClient()).updateSkillContent(agentId, skillName, content),
  );

  ipcMain.handle(
    'skills:create',
    async (_e, agentId: string, name: string, description: string, content: string) =>
      (await getSkillsClient()).createSkill(agentId, name, description, content),
  );

  ipcMain.handle('skills:getConfig', async (_e, agentId: string) =>
    (await getSkillsClient()).skillsConfig(agentId),
  );

  ipcMain.handle(
    'skills:updateConfig',
    async (_e, agentId: string, config: SkillsConfig) =>
      (await getSkillsClient()).updateSkillsConfig(agentId, config),
  );

  // -----------------------------------------------------------------------
  // Settings
  // -----------------------------------------------------------------------

  ipcMain.handle('settings:get', async () => {
    return getSettingsStore().get();
  });

  ipcMain.handle(
    'settings:set',
    async (_event, patch: { defaultModel?: string; defaultFallbackModels?: string[] }) => {
      await getSettingsStore().set(patch);
    },
  );

  // -----------------------------------------------------------------------
  // Gateway status
  // -----------------------------------------------------------------------

  ipcMain.handle('gateway:getStatus', () => {
    return gatewayPoller?.getCurrentStatus() ?? 'starting';
  });

  ipcMain.handle('gateway:status', async () => {
    try {
      const client = await getClient(gw);
      await client.health();
      return 'healthy';
    } catch {
      return 'unhealthy';
    }
  });

  // -----------------------------------------------------------------------
  // Setup (simplified — no password)
  // -----------------------------------------------------------------------

  ipcMain.handle('setup:status', async () => {
    try {
      const client = await getClient(gw);
      const health = await client.health();
      const creds = await client.listCredentials();
      return { needsSetup: creds.length === 0, gatewayReady: true };
    } catch {
      return { needsSetup: true, gatewayReady: false };
    }
  });

  ipcMain.handle('setup:ensureGateway', async () => {
    await getClient(gw); // ensureRunning is called inside
  });

  // -----------------------------------------------------------------------
  // Models & Tools
  // -----------------------------------------------------------------------

  ipcMain.handle('models:list', async () => {
    return getModelCache().load();
  });

  ipcMain.handle('models:refresh', async () => {
    return getModelCache().refresh();
  });

  ipcMain.handle('tools:list', async () => {
    return getModelCache().loadTools();
  });

  // -----------------------------------------------------------------------
  // MCP Connectors
  // -----------------------------------------------------------------------

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

  ipcMain.handle('mcp:reauthorize', async (_e, name: string) => {
    const client = await getMcpClient();
    return client.mcpReauthorizeServer(name);
  });

  ipcMain.handle('mcp:getAllowlist', async () => {
    const client = await getMcpClient();
    return client.mcpGetAllowlist();
  });

  ipcMain.handle('mcp:setAllowlist', async (_e, patterns: string[]) => {
    const client = await getMcpClient();
    return client.mcpSetAllowlist(patterns);
  });

  // -----------------------------------------------------------------------
  // WhatsApp pairing
  // -----------------------------------------------------------------------

  ipcMain.handle('whatsapp:startPairing', async (_event, appId: string) => {
    const client = await getClient(gw);

    // Wrap gateway credentials with prefix for this pairing session
    const prefix = `whatsapp-auth:${appId}:`;
    const prefixedStore = {
      get: async (key: string) => {
        // Gateway credentials API only lists keys; for WhatsApp auth we need
        // values. This is a temporary adapter until WhatsApp pairing moves fully
        // to the gateway.
        // TODO: implement credential get-value in gateway
        return null as string | null;
      },
      set: async (key: string, value: string) => {
        await client.setCredential(`${prefix}${key}`, value);
      },
      delete: async (key: string) => {
        await client.removeCredential(`${prefix}${key}`);
      },
      list: async () => {
        const all = await client.listCredentials();
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

  // -----------------------------------------------------------------------
  // Background model cache refresh on startup
  // -----------------------------------------------------------------------

  getModelCache()
    .refresh()
    .catch((err) => {
      console.warn(
        'Background model cache refresh failed:',
        err instanceof Error ? err.message : err,
      );
    });

  // -----------------------------------------------------------------------
  // Cleanup on quit
  // -----------------------------------------------------------------------

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
