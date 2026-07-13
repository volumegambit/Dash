import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
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
import { createGatewayManagementApp } from './management-api.js';
import { ModelsStore } from './models-store.js';
import { createResumableChatHub } from './resumable-chat-hub.js';

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

  constructor(private readonly scenario: MobileTestHarnessScenario) {}

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

async function listen(app: Hono, injectWebSocket: (server: Server) => void): Promise<Server> {
  let resolveListening!: () => void;
  let rejectListening!: (error: Error) => void;
  const listening = new Promise<void>((resolve, reject) => {
    resolveListening = resolve;
    rejectListening = reject;
  });
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }) as Server;
  server.once('listening', resolveListening);
  server.once('error', rejectListening);
  injectWebSocket(server);
  await listening;
  return server;
}

function portOf(server: Server): number {
  const address = server.address() as AddressInfo | null;
  if (!address) throw new Error('Mobile test harness listener has no address');
  return address.port;
}

function closeServer(server: Server | undefined): Promise<void> {
  if (!server?.listening) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
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
  let managementServer: Server | undefined;
  let chatServer: Server | undefined;

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
    createBackend: async () => new ScriptedMobileBackend(scenario),
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
      conversations.close();
      await logger.close();
      if (ownsDataDir) await rm(dataDir, { recursive: true, force: true });
    })();
    return stopPromise;
  };

  try {
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
      token: managementToken,
      startedAt: '2026-07-12T00:00:00.000Z',
      eventBus,
      logger,
    });
    const managementWebSocket = createNodeWebSocket({ app: managementApp });
    managementServer = await listen(managementApp, managementWebSocket.injectWebSocket);

    const chatApp = new Hono();
    const chatWebSocket = createNodeWebSocket({ app: chatApp });
    mountChatWs(chatApp, {
      agents,
      resumableChatHub: hub,
      token: chatToken,
      upgradeWebSocket: chatWebSocket.upgradeWebSocket,
      eventLogStore: conversations.eventLog,
      verbose: false,
    });
    chatServer = await listen(chatApp, chatWebSocket.injectWebSocket);

    const managementPort = portOf(managementServer);
    const chatPort = portOf(chatServer);
    return {
      managementBaseUrl: `http://127.0.0.1:${managementPort}`,
      chatWebSocketUrl: `ws://127.0.0.1:${chatPort}/ws/chat`,
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
