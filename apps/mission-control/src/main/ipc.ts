import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import type {
  PluginInstallRequest,
  PluginInstallResponse,
  PluginRecord,
  PluginSetStateRequest,
  Project,
  RuntimePluginsResponse,
  SkillsConfig,
} from '@dash/management';
import { ManagementClient } from '@dash/management';
import {
  ConversationStore,
  type GatewayManagementClient,
  GatewayStateStore,
  GatewaySupervisor,
  SettingsStore,
  createDefaultKeychainStore,
  defaultProcessSpawner,
} from '@dash/mc';
import type {
  ControlPlaneClient,
  CreateAgentRequest,
  GatewayChannel,
  GatewaySupervisorOptions,
  IssuedGateway,
  ProcessSpawner,
} from '@dash/mc';
import { desktopDir, gatewayDir, logsDir, migrateLegacyLayout } from '@dash/paths';
import { app, dialog, ipcMain, shell } from 'electron';
import type { BrowserWindow } from 'electron';
import WebSocket from 'ws';
import type { ControlPlaneStatus, DeviceInfo, PairingInfo, SetupStatus } from '../shared/ipc.js';
import { ChatService } from './chat-service.js';
import { completeClaudeOAuth, prepareClaudeOAuth } from './claude-auth.js';
import { startCodexOAuth } from './codex-auth.js';
import { createControlPlaneRuntime, readControlPlaneConfig } from './control-plane.js';
import { GatewayPoller } from './gateway-poller.js';
import { buildPairingInfo } from './pairing.js';

const DATA_DIR = process.env.MC_DATA_DIR || desktopDir();

/** Best-effort LAN IPv4 so a phone on the same Wi-Fi can reach the gateway. */
function getLanIp(): string {
  const ifaces = networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const net of ifaces[name] ?? []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return '127.0.0.1';
}

// Capture MC main process logs to a file (shared ~/.dash/logs)
const MC_LOG_PATH = join(logsDir(), 'mc.log');
let mcLogStream: ReturnType<typeof createWriteStream> | undefined;

function initMcLogging(): void {
  if (mcLogStream) return;
  mkdirSync(logsDir(), { recursive: true });
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
// Long-lived WebSocket to the gateway's /projects/ws. Re-broadcasts each
// { topic, payload } frame to the renderer over the `projects:event` IPC
// channel. Reconnected from the gateway health poller's `healthy` branch
// when null; torn down on quit.
let projectsWs: WebSocket | null = null;

function getGatewaySupervisor(
  options: GatewaySupervisorOptions,
  keychain: ReturnType<typeof createDefaultKeychainStore>,
  controlPlaneClient?: ControlPlaneClient,
): GatewaySupervisor {
  if (!gatewaySupervisor) {
    gatewaySupervisor = new GatewaySupervisor(
      options,
      undefined,
      undefined,
      undefined,
      keychain,
      controlPlaneClient,
    );
  }
  return gatewaySupervisor;
}

/**
 * Enroll the local gateway with the hosted control plane under a user-chosen,
 * permanent subdomain. Pure of Electron/IPC so it is unit-testable:
 *   1. read the gateway's own Ed25519 public key over loopback (the gateway
 *      must be running for `/identity` to answer — `ensureRunning` guarantees
 *      it and returns a non-null client),
 *   2. claim the label and bind the pubkey; the CP returns the full subdomain
 *      `<gatewayId>.<zone>`, so we derive the bare `host` zone for the dial URL,
 *   3. cache the non-secret issued record (NO gateway secret/key),
 *   4. restart so the supervisor's relay block picks up the cached record.
 */
export async function enrollGateway(deps: {
  subdomain: string;
  ensureRunning: () => Promise<GatewayManagementClient>;
  restart: () => Promise<unknown>;
  keychain: { setIssuedGateway: (value: IssuedGateway) => Promise<void> };
  controlPlaneClient: Pick<ControlPlaneClient, 'createGateway'>;
}): Promise<void> {
  const client = await deps.ensureRunning();
  const { publicKey } = await client.getRelayIdentity();
  const provision = await deps.controlPlaneClient.createGateway(deps.subdomain, publicKey);
  const prefix = `${provision.gatewayId}.`;
  const host = provision.subdomain.startsWith(prefix)
    ? provision.subdomain.slice(prefix.length)
    : provision.subdomain;
  await deps.keychain.setIssuedGateway({
    gatewayId: provision.gatewayId,
    subdomain: provision.subdomain,
    host,
    dialToken: provision.dialToken,
  });
  await deps.restart();
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
  // Migrate any data left by older versions into the ~/.dash layout before
  // opening any store. Idempotent; skipped when running against a custom
  // MC_DATA_DIR (tests/QA) or a custom DASH_HOME.
  if (!process.env.MC_DATA_DIR && !process.env.DASH_HOME) {
    try {
      const migration = await migrateLegacyLayout();
      for (const line of [...migration.moved, ...migration.notes]) {
        console.log(`[migrate] ${line}`);
      }
    } catch (err) {
      // Never block launch on migration — log and continue. The move is
      // idempotent, so the next launch retries any incomplete step.
      console.error(`[migrate] failed: ${(err as Error).message}`);
    }
  }

  initMcLogging();

  const controlPlaneConfig = readControlPlaneConfig();
  const gwOptions: GatewaySupervisorOptions = {
    gatewayDataDir: DATA_DIR,
    gatewayRuntimeDir: gatewayDir(),
    logsDir: logsDir(),
    projectRoot: resolveProjectRoot(),
    controlPlaneUrl: controlPlaneConfig.baseUrl,
  };

  // Hosted control plane wiring. A single shared keychain backs both the
  // supervisor (gateway + issued-gateway secrets) and the control-plane session
  // (the Clerk id_token), so all gateway/relay secrets live in one place.
  // The session's token resolver feeds the client, so every control-plane API
  // call carries the current token. When the control-plane client is provided,
  // the supervisor enrolls via the control plane instead of self-generating a
  // relay identity (see process.ts).
  const keychain = createDefaultKeychainStore();
  const { session: controlPlaneSession, client: controlPlaneClient } = createControlPlaneRuntime({
    config: controlPlaneConfig,
    tokenStore: {
      // Treat an empty string (written by `clear`) as signed-out — the session
      // only branches on `null`, and some keychain backends won't delete keys.
      get: async () => {
        const token = await keychain.getControlPlaneToken();
        return token ? token : null;
      },
      set: (value) => keychain.setControlPlaneToken(value),
      clear: () => keychain.setControlPlaneToken(''),
    },
  });
  const gw = getGatewaySupervisor(gwOptions, keychain, controlPlaneClient);

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
  // IPC handlers that want direct HTTP access to skills/MCP/projects
  // routes without going through the GatewayManagementClient abstraction.
  // Reads the gateway port from state.json and the bearer token from
  // the OS keychain (via the supervisor); both must be populated or the
  // call throws with the given feature name in the error message.
  const getDirectManagementClient = async (feature: string): Promise<ManagementClient> => {
    const gatewayState = await new GatewayStateStore(DATA_DIR).read();
    if (!gatewayState) {
      throw new Error(`Gateway not running — ${feature} unavailable`);
    }
    const token = await gw.getGatewayToken();
    if (!token) {
      throw new Error(`Gateway not running — ${feature} unavailable`);
    }
    return new ManagementClient(`http://127.0.0.1:${gatewayState.port}`, token);
  };

  const getSkillsClient = (): Promise<ManagementClient> => getDirectManagementClient('Skills API');

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

  // Idempotently record that onboarding is complete. Monotonic: written
  // once and never overwritten. Gateway-independent and keychain-free, so
  // it survives a gateway crash that deletes gateway-state.json — that is
  // what stops a configured user from being mistaken for a first run.
  //
  // Best-effort: a failure to persist the flag (e.g. read-only data dir,
  // disk full) must never bubble up and downgrade an otherwise-healthy
  // launch to `gateway-failed`. It will simply be retried on a later launch.
  const markSetupCompleted = async (): Promise<void> => {
    try {
      const settings = await getSettingsStore().get();
      if (!settings.setupCompletedAt) {
        await getSettingsStore().set({ setupCompletedAt: new Date().toISOString() });
      }
    } catch (err) {
      console.error('[mc] failed to persist setupCompletedAt:', err);
    }
  };

  // A configured install (durable flag, or legacy gateway-state.json) starts
  // the gateway eagerly — its keychain was already approved in a prior
  // session, so access is silent. Only a genuine first run is deferred until
  // the wizard's keychain-consent step fires `setup:ensureGateway`.
  const configuredAtLaunch = isSetupConfigured(
    await getSettingsStore().get(),
    hasExistingGatewayState,
  );
  if (configuredAtLaunch) {
    try {
      await gw.ensureRunning();
    } catch (err) {
      console.error('Gateway startup failed on MC launch:', err);
    }
    await refreshChatServiceConnection();
  } else {
    console.log(
      '[mc] first-run detected (not configured) — deferring gateway start until wizard consents',
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

  // Long-lived WebSocket subscription to the gateway's /projects/ws. Each
  // frame is `{ topic, payload }` where `payload` is already normalized by the
  // gateway to the shape the renderer's reducer expects (bare Issue/Project for
  // entity topics, `{ issue_id }` for detail-mutating topics). We forward
  // `payload` UNCHANGED — do NOT re-wrap it. Mirrors the chat-service WS pattern
  // (`addEventListener`); reconnect is driven by the poller's `healthy` branch.
  function connectToProjectsWs(): void {
    projectsWs?.close();
    projectsWs = null;
    void (async () => {
      const gatewayState = await new GatewayStateStore(DATA_DIR).read();
      if (!gatewayState) return;
      const token = await gw.getGatewayToken();
      if (!token) return;
      const url = `ws://127.0.0.1:${gatewayState.port}/projects/ws?token=${encodeURIComponent(token)}`;
      const ws = new WebSocket(url);
      projectsWs = ws;
      ws.addEventListener('message', (event) => {
        let frame: { topic?: string; payload?: unknown };
        try {
          frame = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (!frame.topic) return;
        const win = getWindow();
        if (win && !win.isDestroyed()) {
          win.webContents.send('projects:event', {
            topic: frame.topic,
            payload: frame.payload ?? {},
          });
        }
      });
      ws.addEventListener('close', () => {
        if (projectsWs === ws) projectsWs = null;
      });
      ws.addEventListener('error', () => {
        // The close handler clears the ref; reconnect happens on the next
        // 'healthy' poll tick.
      });
    })();
  }

  gatewayPoller.start(
    (status: string) => {
      sendGatewayStatus(status);
      if (status === 'healthy') {
        connectToGatewayEvents().catch(() => {});
        if (!projectsWs) connectToProjectsWs();
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

  ipcMain.handle('pairing:getInfo', async (): Promise<PairingInfo> => {
    const gatewayState = await new GatewayStateStore(DATA_DIR).read();
    const chatToken = await gw.getChatToken();
    const managementToken = await gw.getGatewayToken();
    if (!managementToken || !chatToken) {
      throw new Error('Gateway not running — start it before pairing a device');
    }
    // Relay mode is available once the gateway is enrolled with the control
    // plane (an issued-gateway record with a gatewayId + relay host). Absent →
    // LAN pairing. The per-device credential is provisioned by the control
    // plane server-side — MC never holds the relay master secret.
    const issued = await gw.getIssuedGateway();
    return buildPairingInfo(
      {
        mgmtToken: managementToken,
        chatToken,
        lan: {
          host: getLanIp(),
          mgmtPort: gatewayState?.port ?? 9300,
          chatPort: gatewayState?.channelPort ?? 9200,
        },
        relay: issued ? { gatewayId: issued.gatewayId, host: issued.host } : undefined,
      },
      async (gatewayId) => (await controlPlaneClient.createPairing(gatewayId)).credential,
    );
  });

  // -----------------------------------------------------------------------
  // Remote access — hosted control plane (sign in, enroll, manage devices)
  //
  // Replaces the self-hosted relay config (zone / relay token / admin secret).
  // The user signs in with Clerk (system browser, loopback redirect), MC
  // enrolls a gateway with the control plane, and the control plane brokers the
  // relay server-side — MC never holds the relay master secret.
  // -----------------------------------------------------------------------

  ipcMain.handle('controlPlane:status', async (): Promise<ControlPlaneStatus> => {
    const [token, issued] = await Promise.all([
      controlPlaneSession.getToken(),
      gw.getIssuedGateway(),
    ]);
    return {
      signedIn: Boolean(token),
      enrolled: Boolean(issued),
      subdomain: issued ? issued.subdomain : null,
    };
  });

  ipcMain.handle('controlPlane:signIn', async () => {
    await controlPlaneSession.signIn();
  });

  ipcMain.handle('controlPlane:signOut', async () => {
    await controlPlaneSession.signOut();
  });

  ipcMain.handle('controlPlane:subdomainCheck', async (_e, label: string): Promise<boolean> => {
    if (!(await controlPlaneSession.getToken())) {
      throw new Error('Sign in to Dash before checking a subdomain');
    }
    return controlPlaneClient.isSubdomainAvailable(label);
  });

  ipcMain.handle('gateway:enroll', async (_e, subdomain: string): Promise<void> => {
    if (!(await controlPlaneSession.getToken())) {
      throw new Error('Sign in to Dash before enrolling a gateway');
    }
    await enrollGateway({
      subdomain,
      ensureRunning: () => gw.ensureRunning(),
      restart: () => gw.restart(),
      keychain,
      controlPlaneClient,
    });
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

  ipcMain.handle('devices:list', async (): Promise<DeviceInfo[]> => {
    const issued = await gw.getIssuedGateway();
    if (!issued) return [];
    const gateways = await controlPlaneClient.listGateways();
    const match = gateways.find((g) => g.gatewayId === issued.gatewayId);
    return match ? match.devices : [];
  });

  ipcMain.handle('devices:revoke', async (_e, deviceId: string) => {
    const issued = await gw.getIssuedGateway();
    if (!issued) {
      throw new Error('No gateway enrolled — nothing to revoke');
    }
    await controlPlaneClient.revokePairing(issued.gatewayId, deviceId);
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
    // Storing a credential is the reliable "onboarding finished" moment —
    // the wizard's API-key step lands here with a live gateway.
    await markSetupCompleted();
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
      // Access token feeds the agent; refresh + expiry let the gateway keep it
      // fresh (see OAuthRefreshCoordinator). Standardized {provider}-oauth-* slots.
      await client.setCredential(`openai-api-key:${keyName}`, result.accessToken);
      await client.setCredential(`openai-oauth-refresh:${keyName}`, result.refreshToken);
      await client.setCredential(`openai-oauth-expires:${keyName}`, String(result.expiresAt));
      // OAuth onboarding stores credentials directly (not via credentials:set),
      // so mark setup complete here too — otherwise an OAuth-only user has no
      // durable setupCompletedAt and can be mistaken for a first run.
      await markSetupCompleted();

      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[codex-auth] OAuth error:', message);
      return { success: false, error: message };
    }
  });

  // Token refresh is now owned by the gateway, which proactively refreshes
  // near-expiry OAuth tokens (and persists the rotated refresh tokens) before
  // each agent run — see OAuthRefreshCoordinator. The gateway can read stored
  // credential values directly; Mission Control cannot (the management API only
  // lists keys), which is why the old MC-side refresh never worked. This handler
  // is retained for preload-API compatibility and simply reports success; the
  // refresh happens gateway-side on the next chat turn.
  ipcMain.handle('codex:refreshToken', async () => {
    return { success: true };
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
        const result = await completeClaudeOAuth(code, state, verifier);
        if (!result) {
          return { success: false, error: 'Failed to create API key' };
        }
        const client = await getClient(gw);
        // Access token feeds the agent; refresh + expiry let the gateway keep it
        // fresh (see OAuthRefreshCoordinator). All three use the standardized
        // {provider}-oauth-* slot convention.
        await client.setCredential(`anthropic-api-key:${keyName}`, result.accessToken);
        await client.setCredential(`anthropic-oauth-refresh:${keyName}`, result.refreshToken);
        await client.setCredential(`anthropic-oauth-expires:${keyName}`, String(result.expiresAt));
        // See codex:startOAuth — OAuth onboarding bypasses credentials:set, so
        // record onboarding completion here too.
        await markSetupCompleted();

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

  ipcMain.handle('skills:install', async (_e, agentId: string, source: string, name?: string) =>
    (await getSkillsClient()).installSkill(agentId, source, name),
  );

  ipcMain.handle('skills:remove', async (_e, agentId: string, skillName: string) =>
    (await getSkillsClient()).removeSkill(agentId, skillName),
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

  ipcMain.handle('setup:status', async (): Promise<SetupStatus> => {
    // Genuine first run is decided WITHOUT touching the gateway/keychain:
    // the durable `setupCompletedAt` flag, or a legacy `gateway-state.json`.
    // Returning `needs-setup` here short-circuits before `getClient(gw)` →
    // `gw.ensureRunning()`, so a brand-new install never surfaces a native
    // keychain prompt before the wizard's consent step.
    //
    // A configured user DOES reach `ensureHealthyClient` — but their keychain
    // was approved in a prior session, so access is silent. If the gateway
    // can't start, this returns `gateway-failed` (the recovery screen), NOT
    // `needs-setup` (the onboarding wizard).
    return resolveSetupStatus({
      isConfigured: async () =>
        isSetupConfigured(await getSettingsStore().get(), existsSync(gatewayStateJsonPath)),
      ensureHealthyClient: async () => {
        const client = await getClient(gw);
        await client.health();
        return client;
      },
      markSetupCompleted,
    });
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

  const getMcpClient = (): Promise<ManagementClient> => getDirectManagementClient('Connectors');

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
  // Plugins (gateway passthrough)
  // -----------------------------------------------------------------------

  const getPluginsClient = (): Promise<ManagementClient> =>
    getDirectManagementClient('Plugins API');

  ipcMain.handle('plugins:list', async () => pluginsListHandler(await getPluginsClient()));

  ipcMain.handle('plugins:setState', async (_e, name: string, patch: PluginSetStateRequest) =>
    pluginSetStateHandler(await getPluginsClient(), name, patch),
  );

  ipcMain.handle('plugins:install', async (_e, req: PluginInstallRequest) =>
    pluginInstallHandler(await getPluginsClient(), req),
  );

  ipcMain.handle('plugins:remove', async (_e, name: string) =>
    pluginRemoveHandler(await getPluginsClient(), name),
  );

  ipcMain.handle('plugins:reload', async () => pluginReloadHandler(await getPluginsClient()));

  ipcMain.handle('plugins:runtime', async () => pluginRuntimeHandler(await getPluginsClient()));

  // -----------------------------------------------------------------------
  // Projects
  // -----------------------------------------------------------------------

  const getProjectsClient = (): Promise<ManagementClient> => getDirectManagementClient('Projects');

  ipcMain.handle('projects:listProjects', async (_e, status?: string) =>
    (await getProjectsClient()).listProjects(status as Project['status'] | undefined),
  );
  ipcMain.handle('projects:createProject', async (_e, input) =>
    (await getProjectsClient()).createProject(input),
  );
  ipcMain.handle('projects:getProject', async (_e, id: string) =>
    (await getProjectsClient()).getProject(id),
  );
  ipcMain.handle('projects:patchProject', async (_e, id: string, patch) =>
    (await getProjectsClient()).patchProject(id, patch),
  );
  ipcMain.handle('projects:listProjectIssues', async (_e, id: string) =>
    (await getProjectsClient()).listProjectIssues(id),
  );

  ipcMain.handle('projects:listIssues', async (_e, filters) =>
    (await getProjectsClient()).listIssues(filters ?? {}),
  );
  ipcMain.handle('projects:createIssue', async (_e, input) =>
    (await getProjectsClient()).createIssue(input),
  );
  ipcMain.handle('projects:getIssue', async (_e, id: string) =>
    (await getProjectsClient()).getIssue(id),
  );
  ipcMain.handle('projects:patchIssue', async (_e, id: string, patch) =>
    (await getProjectsClient()).patchIssue(id, patch),
  );
  ipcMain.handle('projects:addComment', async (_e, issueId: string, body: string) =>
    (await getProjectsClient()).addComment(issueId, body),
  );
  ipcMain.handle(
    'projects:editComment',
    async (_e, issueId: string, commentId: string, body: string) =>
      (await getProjectsClient()).editComment(issueId, commentId, body),
  );
  ipcMain.handle('projects:deleteComment', async (_e, issueId: string, commentId: string) =>
    (await getProjectsClient()).deleteComment(issueId, commentId),
  );

  ipcMain.handle('projects:listInbox', async () => (await getProjectsClient()).listInbox());
  ipcMain.handle('projects:markInboxRead', async (_e, issueId: string) =>
    (await getProjectsClient()).markInboxRead(issueId),
  );

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

  const GATEWAY_LOG_PATH = join(logsDir(), 'gateway.log');

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
    projectsWs?.close();
    gatewayPoller?.stop();
    await shutdownGatewayOnQuit(DATA_DIR);
  });
}

/**
 * Terminate the running gateway process at MC shutdown, but leave
 * `gateway-state.json` on disk.
 *
 * Why keep the state file around? The file doubles as the "has this user
 * ever completed Dash setup?" signal at the top of `registerIpcHandlers`
 * — deleting it here would make every subsequent launch look like a
 * first run, re-triggering the wizard-consent deferral path even though
 * the keychain and the rest of the data dir are fully populated.
 *
 * Leaving the stale record behind is safe: `GatewaySupervisor.ensureRunning`
 * probes the port on next launch, finds it free (because we just killed
 * the process), and calls `store.clear()` itself before spawning a fresh
 * gateway. Exporting this as a named function so the quit-handler
 * contract is unit-testable without simulating the whole Electron app.
 */
// ---------------------------------------------------------------------------
// Plugin management handlers (gateway passthrough)
//
// Extracted as pure functions over a ManagementClient so the bridge logic
// (record unwrapping, argument forwarding) is unit-testable without booting
// Electron. registerIpcHandlers wires them to the `plugins:*` IPC channels.
// ---------------------------------------------------------------------------

/** Unwrap the gateway's `{ records }` envelope into a flat list for the UI. */
export async function pluginsListHandler(
  client: Pick<ManagementClient, 'pluginsList'>,
): Promise<PluginRecord[]> {
  const resp = await client.pluginsList();
  return resp.records;
}

export async function pluginSetStateHandler(
  client: Pick<ManagementClient, 'pluginSetState'>,
  name: string,
  patch: PluginSetStateRequest,
): Promise<PluginRecord> {
  return client.pluginSetState(name, patch);
}

export async function pluginInstallHandler(
  client: Pick<ManagementClient, 'pluginInstall'>,
  req: PluginInstallRequest,
): Promise<PluginInstallResponse> {
  return client.pluginInstall(req.source, req.name);
}

export async function pluginRemoveHandler(
  client: Pick<ManagementClient, 'pluginRemove'>,
  name: string,
): Promise<{ ok: boolean; path?: string }> {
  return client.pluginRemove(name);
}

export async function pluginReloadHandler(
  client: Pick<ManagementClient, 'pluginReload'>,
): Promise<{ ok: boolean; reloadedAt?: string }> {
  return client.pluginReload();
}

export async function pluginRuntimeHandler(
  client: Pick<ManagementClient, 'runtimePlugins'>,
): Promise<RuntimePluginsResponse> {
  return client.runtimePlugins();
}

export async function shutdownGatewayOnQuit(dataDir: string): Promise<void> {
  const store = new GatewayStateStore(dataDir);
  const gatewayState = await store.read();
  if (!gatewayState) return;
  try {
    process.kill(gatewayState.pid, 'SIGTERM');
  } catch {
    // Already dead — SIGTERM on a missing PID throws ESRCH; expected.
  }
  // Deliberately NOT clearing the state file here. See docstring above.
}

/**
 * Whether this install has completed onboarding, independent of whether the
 * gateway is currently running. The durable signal is the `setupCompletedAt`
 * flag in MC settings; an existing `gateway-state.json` is accepted as a
 * legacy fallback so healthy pre-flag installs are never re-onboarded.
 */
export function isSetupConfigured(
  settings: { setupCompletedAt?: string },
  legacyStateExists: boolean,
): boolean {
  return Boolean(settings.setupCompletedAt) || legacyStateExists;
}

export interface SetupStatusDeps {
  isConfigured: () => Promise<boolean>;
  ensureHealthyClient: () => Promise<{ listCredentials: () => Promise<string[]> }>;
  markSetupCompleted: () => Promise<void>;
}

/**
 * Decide which top-level screen MC should show. Pure + dependency-injected so
 * every branch is unit-testable without Electron or a live gateway.
 *
 * The genuine-first-run path returns BEFORE `ensureHealthyClient` is called,
 * preserving the invariant that a brand-new install never touches the gateway
 * or OS keychain before the consent UI.
 */
export async function resolveSetupStatus(deps: SetupStatusDeps): Promise<SetupStatus> {
  if (!(await deps.isConfigured())) return { state: 'needs-setup' };
  try {
    const client = await deps.ensureHealthyClient();
    const creds = await client.listCredentials();
    if (creds.length === 0) return { state: 'needs-setup' };
    await deps.markSetupCompleted();
    return { state: 'ready' };
  } catch (err) {
    return { state: 'gateway-failed', error: err instanceof Error ? err.message : String(err) };
  }
}
