import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SkillsConfig } from '@dash/management';
import { ManagementClient } from '@dash/management';
import {
  ConversationStore,
  type GatewayManagementClient,
  GatewayStateStore,
  GatewaySupervisor,
  SettingsStore,
  defaultProcessSpawner,
  getPlatformDataDir,
} from '@dash/mc';
import type {
  CreateAgentRequest,
  GatewayChannel,
  GatewaySupervisorOptions,
  ProcessSpawner,
} from '@dash/mc';
import { app, dialog, ipcMain, shell } from 'electron';
import type { BrowserWindow } from 'electron';
import { ChatService } from './chat-service.js';
import { completeClaudeOAuth, prepareClaudeOAuth } from './claude-auth.js';
import { refreshCodexToken, startCodexOAuth } from './codex-auth.js';
import { GatewayPoller } from './gateway-poller.js';

const DATA_DIR = process.env.MC_DATA_DIR || getPlatformDataDir('dash');

// Capture MC main process logs to a file
const MC_LOG_PATH = join(DATA_DIR, 'logs', 'mc.log');
let mcLogStream: ReturnType<typeof createWriteStream> | undefined;

function initMcLogging(): void {
  if (mcLogStream) return;
  const logsDir = join(DATA_DIR, 'logs');
  mkdirSync(logsDir, { recursive: true });
  mcLogStream = createWriteStream(MC_LOG_PATH, { flags: 'a' });
  mcLogStream.write(`\n--- MC starting at ${new Date().toISOString()} ---\n`);

  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);

  const write = (prefix: string, args: unknown[]) => {
    const line = `[${new Date().toISOString()}] ${prefix} ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`;
    mcLogStream?.write(line);
  };

  console.log = (...args: unknown[]) => {
    origLog(...args);
    write('INFO', args);
  };
  console.warn = (...args: unknown[]) => {
    origWarn(...args);
    write('WARN', args);
  };
  console.error = (...args: unknown[]) => {
    origError(...args);
    write('ERROR', args);
  };
}

let chatService: ChatService | undefined;
let gatewayPoller: GatewayPoller | undefined;
let gatewaySupervisor: GatewaySupervisor | undefined;

function getGatewaySupervisor(options: GatewaySupervisorOptions): GatewaySupervisor {
  if (!gatewaySupervisor) {
    gatewaySupervisor = new GatewaySupervisor(options);
  }
  return gatewaySupervisor;
}

async function getClient(gw: GatewaySupervisor): Promise<GatewayManagementClient> {
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

export async function registerIpcHandlers(
  getWindow: () => BrowserWindow | undefined,
): Promise<void> {
  initMcLogging();

  const gwOptions: GatewaySupervisorOptions = {
    gatewayDataDir: DATA_DIR,
    gatewayRuntimeDir: getPlatformDataDir('dash-gateway'),
    projectRoot: resolveProjectRoot(),
  };
  const gw = getGatewaySupervisor(gwOptions);

  // First-run detection: if there's no gateway-state.json yet, we
  // have never successfully started the gateway on this machine and
  // the OS keychain has not yet been touched by the Electron binary.
  // Defer BOTH `gw.ensureRunning()` AND `refreshChatServiceConnection()`
  // until after the setup wizard's keychain-consent step fires
  // `setup:ensureGateway` — otherwise macOS would surface a raw
  // "Electron wants to access your keychain" prompt before any Dash UI
  // has rendered, with no explanation of why.
  const gatewayStateJsonPath = join(DATA_DIR, 'gateway-state.json');
  const hasExistingGatewayState = existsSync(gatewayStateJsonPath);

  // Build a short-lived ManagementClient for the gateway — used by
  // IPC handlers that want direct HTTP access to skills/MCP routes
  // without going through the GatewayManagementClient abstraction.
  // Reads the gateway port from state.json and the bearer token from
  // the OS keychain (via the supervisor); both must be populated or
  // the call throws.
  const getSkillsClient = async (): Promise<ManagementClient> => {
    const gatewayState = await new GatewayStateStore(DATA_DIR).read();
    if (!gatewayState) {
      throw new Error('Gateway not running — Skills API unavailable');
    }
    const token = await gw.getGatewayToken();
    if (!token) {
      throw new Error('Gateway not running — Skills API unavailable');
    }
    return new ManagementClient(`http://127.0.0.1:${gatewayState.port}`, token);
  };

  // Read gateway state and pass connection to ChatService. The chat
  // token lives in the OS keychain (not gateway-state.json), so pull
  // it from the supervisor rather than reaching into the state file.
  // Also forward the management API base URL + token — ChatService
  // uses them to call the gateway's event-log replay endpoint after
  // a dropped WebSocket.
  const refreshChatServiceConnection = async () => {
    const gatewayState = await new GatewayStateStore(DATA_DIR).read();
    const chatToken = await gw.getChatToken();
    const managementToken = await gw.getGatewayToken();
    if (gatewayState) {
      const svc = getChatService(getWindow);
      svc.setGatewayConnection({
        channelPort: gatewayState.channelPort,
        chatToken: chatToken ?? undefined,
        managementBaseUrl: `http://127.0.0.1:${gatewayState.port}`,
        managementToken: managementToken ?? undefined,
      });
      // Fire-and-forget startup reconciliation: scan every
      // conversation for incomplete turns (user message with no
      // reply, or an assistant message missing a `response` event)
      // and fetch whatever the gateway logged while MC was down.
      // Catches the case where MC crashed or was force-quit before
      // the WebSocket close handler's own reconciliation could run.
      svc.reconcileAllConversations().catch((err) => {
        console.error(
          '[ChatService] Startup reconciliation failed:',
          err instanceof Error ? err.message : err,
        );
      });
    }
  };

  if (hasExistingGatewayState) {
    // Returning user — keychain has already been approved for this
    // Electron binary, so accessing it is silent. Eagerly start the
    // gateway and wire up the chat service so the main UI is live
    // before the window renders.
    try {
      await gw.ensureRunning();
    } catch (err) {
      console.error('Gateway startup failed on MC launch:', err);
    }
    await refreshChatServiceConnection();
  } else {
    console.log(
      '[mc] first-run detected (no gateway-state.json) — deferring gateway start until wizard consents',
    );
  }

  // Start gateway health poller.
  //
  // IMPORTANT: the poller uses the read-only `getClient()` path, NOT
  // `ensureRunning()`. Using `ensureRunning` here meant every transient
  // hiccup in the gateway (slow MCP tool call, GC pause, momentary auth
  // error) would trigger a respawn cascade — the root cause of the
  // EADDRINUSE loop we hit. The poller's job is to report "is the
  // gateway we already started still healthy?", not to reconcile
  // lifecycle state. Explicit restart goes through the `gateway:restart`
  // IPC handler below, which does call `gw.restart()`.
  const sendGatewayStatus = (status: string) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send('gateway:status', status);
  };
  gatewayPoller = new GatewayPoller(async () => gw.getClient());

  // SSE subscription to gateway events
  let sseAbort: AbortController | null = null;

  async function connectToGatewayEvents(): Promise<void> {
    sseAbort?.abort();
    const gatewayState = await new GatewayStateStore(DATA_DIR).read();
    if (!gatewayState) return;
    const token = await gw.getGatewayToken();
    if (!token) return;

    const abort = new AbortController();
    sseAbort = abort;

    try {
      const res = await fetch(`http://127.0.0.1:${gatewayState.port}/events`, {
        headers: { Authorization: `Bearer ${token}` },
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
  });

  ipcMain.handle('credentials:list', async () => {
    const client = await getClient(gw);
    return client.listCredentials();
  });

  ipcMain.handle('credentials:remove', async (_e, key: string) => {
    const client = await getClient(gw);
    await client.removeCredential(key);
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

  // Migrate legacy conversations (deploymentId+agentName → agentId) on first list
  let conversationsMigrated = false;
  ipcMain.handle('chat:listConversations', async () => {
    if (!conversationsMigrated) {
      conversationsMigrated = true;
      try {
        const client = await getClient(gw);
        const agents = await client.listAgents();
        const convStore = new ConversationStore(DATA_DIR);
        await convStore.migrate((agentName) => {
          const match = agents.find((a) => a.name === agentName);
          return match?.id ?? null;
        });
      } catch {
        // Gateway not ready — migration will retry next time
        conversationsMigrated = false;
      }
    }
    return getChatService(getWindow).listConversations();
  });

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

  ipcMain.handle('skills:updateConfig', async (_e, agentId: string, config: SkillsConfig) =>
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

  ipcMain.handle('gateway:restart', async () => {
    await gw.restart();
    // Update chat service connection with new gateway. Chat token
    // and management token are keychain-resident; read them via
    // the supervisor.
    const state = await new GatewayStateStore(DATA_DIR).read();
    const chatToken = await gw.getChatToken();
    const managementToken = await gw.getGatewayToken();
    if (state && chatService) {
      chatService.setGatewayConnection({
        channelPort: state.channelPort,
        chatToken: chatToken ?? undefined,
        managementBaseUrl: `http://127.0.0.1:${state.port}`,
        managementToken: managementToken ?? undefined,
      });
    }
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
    // First-run short-circuit: when `gateway-state.json` does not exist
    // the gateway has never been started by this install AND the OS
    // keychain has not yet been touched by the Electron binary. We
    // must NOT call `getClient(gw)` here — doing so would trigger
    // `gw.ensureRunning()` → native keychain prompt before the user
    // has seen any Dash-branded UI. Return needsSetup without touching
    // the gateway; the wizard will call `setup:ensureGateway` after
    // the user has acknowledged the keychain-consent modal.
    if (!existsSync(gatewayStateJsonPath)) {
      return { needsSetup: true, gatewayReady: false };
    }
    try {
      const client = await getClient(gw);
      await client.health();
      const creds = await client.listCredentials();
      return { needsSetup: creds.length === 0, gatewayReady: true };
    } catch {
      return { needsSetup: true, gatewayReady: false };
    }
  });

  ipcMain.handle('setup:ensureGateway', async () => {
    await getClient(gw); // ensureRunning is called inside
    // Now that the keychain has been touched (and on first run,
    // approved by the user), wire up the chat service connection
    // that was deferred at startup.
    await refreshChatServiceConnection();
  });

  ipcMain.handle('app:quit', () => {
    app.quit();
  });

  // -----------------------------------------------------------------------
  // Models & Tools
  // -----------------------------------------------------------------------

  // Gateway is the source of truth for the model list. MC just calls
  // through — the gateway handles persistence, bootstrap fallback, and
  // SUPPORTED_MODELS filtering.
  ipcMain.handle('models:list', async () => {
    const client = await getClient(gw);
    return client.listModels();
  });

  ipcMain.handle('models:refresh', async () => {
    const client = await getClient(gw);
    return client.refreshModels();
  });

  ipcMain.handle('models:debug', async () => {
    const client = await getClient(gw);
    return client.debugModels();
  });

  ipcMain.handle('tools:list', async () => {
    // Tools list is static and shipped in @dash/agent. No gateway call.
    const { AGENT_TOOL_NAMES } = await import('@dash/agent');
    return [...AGENT_TOOL_NAMES];
  });

  // -----------------------------------------------------------------------
  // MCP Connectors
  // -----------------------------------------------------------------------

  async function getMcpClient(): Promise<ManagementClient> {
    const gatewayState = await new GatewayStateStore(DATA_DIR).read();
    if (!gatewayState) {
      throw new Error('Gateway not running — Connectors unavailable');
    }
    const token = await gw.getGatewayToken();
    if (!token) {
      throw new Error('Gateway not running — Connectors unavailable');
    }
    return new ManagementClient(`http://127.0.0.1:${gatewayState.port}`, token);
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
  // Under the Hood — log reading (dev mode)
  // -----------------------------------------------------------------------

  const GATEWAY_LOG_PATH = join(DATA_DIR, 'logs', 'gateway.log');

  ipcMain.handle('logs:read', async (_e, source: 'mc' | 'gateway', tailLines = 500) => {
    const logPath = source === 'mc' ? MC_LOG_PATH : GATEWAY_LOG_PATH;
    try {
      const content = await readFile(logPath, 'utf-8');
      const lines = content.split('\n');
      return lines.slice(-tailLines).join('\n');
    } catch {
      return `No ${source} logs found yet.`;
    }
  });

  ipcMain.handle('logs:paths', async () => {
    return { mc: MC_LOG_PATH, gateway: GATEWAY_LOG_PATH, dataDir: DATA_DIR };
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
