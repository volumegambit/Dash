import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentBackend, AgentEvent, AgentState, RunOptions } from '@dash/agent';
import { StructuredLoggerImpl } from '@dash/logging';
import { serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { Hono } from 'hono';
import { createAgentChatCoordinator } from './agent-chat-coordinator.js';
import { AgentRegistry } from './agent-registry.js';
import { ChannelRegistry } from './channel-registry.js';
import { mountChatWs } from './chat-ws.js';
import { createConversationAutoTitleService } from './conversation-auto-title.js';
import { SqliteConversationService } from './conversation-service-sqlite.js';
import { GatewayCredentialStore } from './credential-store.js';
import { EventBus } from './event-bus.js';
import { createDynamicGateway } from './gateway.js';
import { createLanMobileApp } from './lan-mobile-app.js';
import { loadOrCreateLanTlsIdentity } from './lan-tls.js';
import { createGatewayManagementApp } from './management-api.js';
import { ModelsStore } from './models-store.js';
import { createResumableChatHub } from './resumable-chat-hub.js';
import { mountWsTicketRoute } from './ws-ticket-store.js';

export type MobileTestHarnessScenario = 'stream' | 'question' | 'slow';

export interface MobileTestHarnessOptions {
  scenario?: MobileTestHarnessScenario;
  dataDir?: string;
  managementToken?: string;
  chatToken?: string;
}

export interface RunningMobileTestHarness {
  managementBaseUrl: string;
  chatWebSocketUrl: string;
  mobileBaseUrl: string;
  mobileChatWebSocketUrl: string;
  tlsCertificateSha256: string;
  managementToken: string;
  chatToken: string;
  gatewayId: string;
  agentId: string;
  dataDir: string;
  stop(): Promise<void>;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve'];
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function waitBetweenEvents(ms: number, aborted: Promise<void>): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (wasAborted: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(wasAborted);
    };
    const timer = setTimeout(() => finish(false), ms);
    void aborted.then(() => finish(true));
  });
}

class ScriptedMobileBackend implements AgentBackend {
  readonly name = 'mobile-test-scripted';
  private stopped = false;
  private activeAbort: Deferred<void> | null = null;
  private activeAnswer: Deferred<string> | null = null;

  constructor(
    private readonly scenario: MobileTestHarnessScenario,
    private readonly slowEventRelease: Promise<void>,
  ) {}

  async start(_workspace: string): Promise<void> {
    this.stopped = false;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.abort();
  }

  abort(): void {
    this.activeAbort?.resolve();
  }

  async answerQuestion(id: string, answers: string[][]): Promise<void> {
    if (id !== 'question-01' || !this.activeAnswer) return;
    this.activeAnswer.resolve(answers[0]?.[0] ?? '');
  }

  async *run(_state: AgentState, _options: RunOptions): AsyncGenerator<AgentEvent> {
    if (this.stopped) return;
    const aborted = deferred<void>();
    this.activeAbort = aborted;
    try {
      if (this.scenario === 'slow') {
        yield { type: 'text_delta', text: 'Starting' };
        const released = await Promise.race([
          this.slowEventRelease.then(() => true),
          aborted.promise.then(() => false),
        ]);
        if (!released) return;
        yield { type: 'text_delta', text: 'Working' };
        await aborted.promise;
        return;
      }

      if (this.scenario === 'question') {
        const answer = deferred<string>();
        this.activeAnswer = answer;
        yield {
          type: 'question',
          id: 'question-01',
          question: 'Choose a color',
          options: ['Blue', 'Green'],
        };
        const selected = await Promise.race([
          answer.promise.then((value) => ({ type: 'answer' as const, value })),
          aborted.promise.then(() => ({ type: 'abort' as const })),
        ]);
        if (selected.type === 'abort') return;
        yield {
          type: 'response',
          content: `Selected: ${selected.value}`,
          usage: { inputTokens: 5, outputTokens: 2 },
        };
        return;
      }

      const events: AgentEvent[] = [
        { type: 'text_delta', text: 'Hello' },
        { type: 'text_delta', text: ' from Dash' },
        {
          type: 'response',
          content: 'Hello from Dash',
          usage: { inputTokens: 4, outputTokens: 3 },
        },
      ];
      for (let index = 0; index < events.length; index += 1) {
        yield events[index];
        if (index < events.length - 1 && (await waitBetweenEvents(50, aborted.promise))) return;
      }
    } finally {
      if (this.activeAbort === aborted) this.activeAbort = null;
      this.activeAnswer = null;
    }
  }
}

interface OwnedServer {
  server: Server;
  close(): Promise<void>;
}

async function listen(
  app: Hono,
  injectWebSocket: (server: Server) => void,
  tls?: { privateKey: string; certificate: string },
): Promise<OwnedServer> {
  const server = serve(
    tls
      ? {
          fetch: app.fetch,
          hostname: '127.0.0.1',
          port: 0,
          createServer: createHttpsServer,
          serverOptions: { key: tls.privateKey, cert: tls.certificate },
        }
      : { fetch: app.fetch, hostname: '127.0.0.1', port: 0 },
  ) as Server;
  const sockets = new Set<Socket>();
  let closing = false;
  let closePromise: Promise<void> | undefined;
  const trackConnection = (socket: Socket): void => {
    if (closing) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  };
  server.on('connection', trackConnection);

  const close = (): Promise<void> => {
    closePromise ??= new Promise<void>((resolve, reject) => {
      closing = true;
      const finish = (error?: Error): void => {
        server.off('connection', trackConnection);
        sockets.clear();
        if (error) reject(error);
        else resolve();
      };
      if (!server.listening) {
        for (const socket of sockets) socket.destroy();
        finish();
        return;
      }
      server.close((error) => finish(error));
      server.closeAllConnections();
      for (const socket of sockets) socket.destroy();
    });
    return closePromise;
  };

  try {
    injectWebSocket(server);
    await new Promise<void>((resolve, reject) => {
      const onListening = (): void => {
        server.off('error', onError);
        resolve();
      };
      const onError = (error: Error): void => {
        server.off('listening', onListening);
        reject(error);
      };
      server.once('listening', onListening);
      server.once('error', onError);
    });
    return { server, close };
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }
}

function portOf(ownedServer: OwnedServer): number {
  const address = ownedServer.server.address() as AddressInfo | null;
  if (!address) throw new Error('Mobile test harness listener has no address');
  return address.port;
}

function closeServer(server: OwnedServer | undefined): Promise<void> {
  return server?.close() ?? Promise.resolve();
}

export async function startMobileTestHarness(
  options: MobileTestHarnessOptions = {},
): Promise<RunningMobileTestHarness> {
  const scenario = options.scenario ?? 'stream';
  const ownsDataDir = options.dataDir === undefined;
  const dataDir = options.dataDir ?? (await mkdtemp(join(tmpdir(), 'dash-mobile-harness-')));
  await mkdir(dataDir, { recursive: true });

  const managementToken = options.managementToken ?? 'mobile-test-management-token';
  const chatToken = options.chatToken ?? 'mobile-test-chat-token';
  const gatewayId = 'mobile-test-gateway';
  const logger = new StructuredLoggerImpl('error', []);
  const agentRegistry = new AgentRegistry(join(dataDir, 'agents.json'));
  const channelRegistry = new ChannelRegistry(join(dataDir, 'channels.json'));
  const credentialStore = new GatewayCredentialStore(dataDir);
  const modelsStore = new ModelsStore(dataDir);
  const conversations = new SqliteConversationService({ dataDir });
  const eventBus = new EventBus();
  const gateway = createDynamicGateway({ dataDir });
  const slowEventRelease = deferred<void>();
  let managementServer: OwnedServer | undefined;
  let chatServer: OwnedServer | undefined;
  let lanServer: OwnedServer | undefined;

  await credentialStore.init();
  const registered = agentRegistry.register({
    name: 'mobile-test-agent',
    model: 'test/scripted',
    systemPrompt: 'Deterministic mobile contract test agent.',
  });
  await agentRegistry.save();

  const agents = createAgentChatCoordinator({
    registry: agentRegistry,
    poolMaxSize: 32,
    createBackend: async () => new ScriptedMobileBackend(scenario, slowEventRelease.promise),
  });
  gateway.registerAgent(registered.id, {
    chat(channelId, conversationId, text) {
      return agents.chat({ agentId: registered.id, channelId, conversationId, text });
    },
    listSkills() {
      return agents.listSkills(registered.id);
    },
  });
  await gateway.start();

  const autoTitle = createConversationAutoTitleService({
    conversations,
    generateTitle: async () => 'Mobile test conversation',
    onChanged: (summary) =>
      eventBus.emit({
        type: 'conversation:changed',
        conversationId: summary.id,
        revision: summary.revision,
      }),
    logger,
  });
  const hub = createResumableChatHub({
    conversations,
    agents,
    autoTitle,
    onChanged: (summary) =>
      eventBus.emit({
        type: 'conversation:changed',
        conversationId: summary.id,
        revision: summary.revision,
      }),
  });

  let stopPromise: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopPromise ??= (async () => {
      await hub.stop();
      await autoTitle.flush();
      await agents.stop();
      await gateway.stop();
      await closeServer(managementServer);
      await closeServer(chatServer);
      await closeServer(lanServer);
      conversations.close();
      await logger.close();
      if (ownsDataDir) await rm(dataDir, { recursive: true, force: true });
    })();
    return stopPromise;
  };

  try {
    const lanTls = await loadOrCreateLanTlsIdentity(dataDir, ['127.0.0.1']);
    const managementApp = createGatewayManagementApp({
      gateway,
      agents,
      agentRegistry,
      channelRegistry,
      identity: { gatewayId, publicKey: 'mobile-test-public-key' },
      credentialStore,
      modelsStore,
      conversationService: conversations,
      resumableChatHub: hub,
      mobileToken: chatToken,
      token: managementToken,
      lanTlsFingerprint: lanTls.fingerprint,
      startedAt: '2026-07-12T00:00:00.000Z',
      eventBus,
      logger,
    });
    managementApp.post('/mobile/v1/__mobile-test/slow/release', (context) => {
      if (context.req.header('Authorization') !== `Bearer ${chatToken}`) {
        return context.json({ error: 'Unauthorized' }, 401);
      }
      if (scenario !== 'slow') {
        return context.json({ error: 'Slow scenario is not active' }, 409);
      }
      slowEventRelease.resolve();
      return context.body(null, 204);
    });
    const managementWebSocket = createNodeWebSocket({ app: managementApp });
    managementServer = await listen(managementApp, managementWebSocket.injectWebSocket);

    // Mirrors the production wiring in index.ts: ONE ticket store, created
    // before any listener (which also registers `POST /mobile/v1/ws-ticket` on
    // `managementApp`), threaded into EVERY `/ws/chat` mount below. The chat
    // listener is the one the relay forwards browser traffic to, so a ticket
    // minted over HTTP has to be redeemable there — not only on the pinned LAN
    // surface.
    const wsTickets = mountWsTicketRoute(managementApp);

    const chatApp = new Hono();
    const chatWebSocket = createNodeWebSocket({ app: chatApp });
    mountChatWs(chatApp, {
      agents,
      resumableChatHub: hub,
      token: chatToken,
      upgradeWebSocket: chatWebSocket.upgradeWebSocket,
      eventLogStore: conversations.eventLog,
      verbose: false,
      wsTickets,
    });
    chatServer = await listen(chatApp, chatWebSocket.injectWebSocket);

    const lanApp = createLanMobileApp(managementApp);
    const lanWebSocket = createNodeWebSocket({ app: lanApp });
    mountChatWs(lanApp, {
      agents,
      resumableChatHub: hub,
      token: chatToken,
      upgradeWebSocket: lanWebSocket.upgradeWebSocket,
      eventLogStore: conversations.eventLog,
      verbose: false,
      wsTickets,
    });
    lanServer = await listen(lanApp, lanWebSocket.injectWebSocket, lanTls);

    const managementPort = portOf(managementServer);
    const chatPort = portOf(chatServer);
    const lanPort = portOf(lanServer);
    return {
      managementBaseUrl: `http://127.0.0.1:${managementPort}`,
      chatWebSocketUrl: `ws://127.0.0.1:${chatPort}/ws/chat`,
      mobileBaseUrl: `https://127.0.0.1:${lanPort}`,
      mobileChatWebSocketUrl: `wss://127.0.0.1:${lanPort}/ws/chat`,
      tlsCertificateSha256: lanTls.fingerprint,
      managementToken,
      chatToken,
      gatewayId,
      agentId: registered.id,
      dataDir,
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
