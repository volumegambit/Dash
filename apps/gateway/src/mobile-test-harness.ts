import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  AgentBackend,
  AgentEvent,
  AgentState,
  RunOptions,
  SteerContent,
  SteerResult,
} from '@dash/agent';
import { StructuredLoggerImpl } from '@dash/logging';
import type {
  MobileV2ConversationBootstrap,
  MobileV2PendingInput,
  MobileV2WsClientFrame,
  MobileV2WsServerFrame,
} from '@dash/mobile-contract-v2';
import { serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import addFormats from 'ajv-formats';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { type Env, Hono } from 'hono';
import { WebSocket } from 'ws';
import { parse } from 'yaml';
import { GatewayAdmissionController } from './admission-controller.js';
import { createAgentChatCoordinator } from './agent-chat-coordinator.js';
import { AgentRegistry } from './agent-registry.js';
import { ChannelRegistry } from './channel-registry.js';
import { type ChatWsLifecycle, mountChatWs } from './chat-ws.js';
import { createConversationAutoTitleService } from './conversation-auto-title.js';
import { SqliteConversationService } from './conversation-service-sqlite.js';
import { GatewayCredentialStore } from './credential-store.js';
import { EventBus } from './event-bus.js';
import { recoverGatewayTurns } from './gateway-recovery.js';
import { createDynamicGateway } from './gateway.js';
import { createLanMobileApp } from './lan-mobile-app.js';
import { loadOrCreateLanTlsIdentity } from './lan-tls.js';
import { createGatewayManagementApp, resumePendingAgentDeletions } from './management-api.js';
import { ModelsStore } from './models-store.js';
import { createResumableChatHub } from './resumable-chat-hub.js';
import { type GatewayShutdownCoordinator, createGatewayShutdownCoordinator } from './shutdown.js';
import { mountWsTicketRoute } from './ws-ticket-store.js';

const v2ContractRoot = fileURLToPath(new URL('../../../contracts/mobile/v2/', import.meta.url));
const v2OpenApi = parse(readFileSync(join(v2ContractRoot, 'openapi.yaml'), 'utf8')) as object;
const v2ChatSchema = JSON.parse(
  readFileSync(join(v2ContractRoot, 'chat-ws.schema.json'), 'utf8'),
) as object;
const v2Ajv = new Ajv2020({ allErrors: true, strict: false });
(addFormats as unknown as (instance: Ajv2020) => void)(v2Ajv);
v2Ajv.addSchema(v2OpenApi, 'mobile-test-harness-v2-openapi');
v2Ajv.addSchema(v2ChatSchema, 'mobile-test-harness-v2-chat');
const validateV2Bootstrap = v2Ajv.compile({
  $ref: 'mobile-test-harness-v2-openapi#/components/schemas/MobileV2ConversationBootstrap',
});
const validateV2ServerFrame = v2Ajv.compile({
  $ref: 'mobile-test-harness-v2-chat#/$defs/MobileV2WsServerFrame',
});

function requireValidV2<T>(validate: typeof validateV2Bootstrap, value: unknown, label: string): T {
  if (!validate(value)) {
    throw new Error(
      `${label} failed mobile v2 schema validation: ${v2Ajv.errorsText(validate.errors)}`,
    );
  }
  return value as T;
}

export type MobileTestHarnessScenario =
  | 'stream'
  | 'question'
  | 'slow'
  | 'follow-up-v2'
  | 'follow-up-v2-restart'
  | 'follow-up-v1-fallback';

export type MobileTestHarnessProviderGate =
  | 'beforeSafeBoundary'
  | 'afterSqliteDelivery'
  | 'beforeProviderStart'
  | 'beforePiMessagePersist'
  | 'beforeRunTerminal'
  | 'afterFollowUpClaim';

export interface MobileTestHarnessProviderExecution {
  runId: string;
  inputId: string | null;
  count: number;
}

export interface MobileTestHarnessProviderExecutions {
  executions: MobileTestHarnessProviderExecution[];
}

export interface MobileTestHarnessV2Client {
  readonly frames: readonly MobileV2WsServerFrame[];
  readonly lastV2Seq: number;
  send(frame: MobileV2WsClientFrame): void;
  waitFor(
    predicate: (frame: MobileV2WsServerFrame) => boolean,
    options?: { afterV2Seq?: number },
  ): Promise<MobileV2WsServerFrame>;
  waitForV2Seq(v2Seq: number): Promise<void>;
  close(): Promise<void>;
}

type V2SubscribedFrame = Extract<MobileV2WsServerFrame, { type: 'conversation_subscribed' }>;
type V2InputAcceptedFrame = Extract<MobileV2WsServerFrame, { type: 'input_accepted' }>;
type V2InputUpdatedFrame = Extract<MobileV2WsServerFrame, { type: 'input_updated' }>;
type V2InputRemovedFrame = Extract<MobileV2WsServerFrame, { type: 'input_removed' }>;
type V2QueueResumedFrame = Extract<MobileV2WsServerFrame, { type: 'queue_resumed' }>;
type V2DoneFrame = Extract<MobileV2WsServerFrame, { type: 'done' }>;

export interface MobileTestHarnessOptions {
  scenario?: MobileTestHarnessScenario;
  dataDir?: string;
  managementToken?: string;
  chatToken?: string;
  /**
   * What this harness's `/identity` route reports as its public key. Callers
   * that ALSO enroll the harness with a control plane (see
   * `live-account-flow-harness-cli.ts`) must pass the SAME key they registered
   * — clients cross-check the two, so a harness that self-reports a stand-in
   * value would fail verification for the wrong reason. Defaults to a fixed
   * stand-in for the direct-LAN suites, which never enroll anything.
   */
  publicKey?: string;
  /** Test-only fault: the next durable Steer delivery throws before commit. */
  failSteerDeliveryOnce?: boolean;
  /** Test-only fault: the first restart fails after binding its management listener. */
  failRestartOnceAfterManagementListen?: boolean;
  /** Test-only fault: the first restart fails before recovery or listener creation. */
  failRestartOnceDuringInitialization?: boolean;
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
  /** Exactly what this harness's `/identity` route reports. */
  publicKey: string;
  agentId: string;
  dataDir: string;
  connectV2(options?: {
    webSocketUrl?: string;
    token?: string;
    rejectUnauthorized?: boolean;
  }): Promise<MobileTestHarnessV2Client>;
  bootstrapV2(conversationId: string): Promise<MobileV2ConversationBootstrap>;
  subscribeConversation(
    client: MobileTestHarnessV2Client,
    input: {
      conversationId: string;
      sinceV2Seq?: number;
      commandId?: string;
      agentId?: string;
    },
  ): Promise<V2SubscribedFrame>;
  enqueueInput(
    client: MobileTestHarnessV2Client,
    input: {
      conversationId: string;
      text: string;
      behavior: 'steer' | 'followUp';
      expectedActiveTurnId?: string;
      images?: MobileV2PendingInput['images'];
      commandId?: string;
      inputId?: string;
      agentId?: string;
      channelId?: string;
    },
  ): Promise<V2InputAcceptedFrame>;
  editFollowUp(
    client: MobileTestHarnessV2Client,
    input: {
      conversationId: string;
      inputId: string;
      expectedRevision: number;
      text: string;
      images?: MobileV2PendingInput['images'];
      commandId?: string;
    },
  ): Promise<V2InputUpdatedFrame>;
  removeFollowUp(
    client: MobileTestHarnessV2Client,
    input: {
      conversationId: string;
      inputId: string;
      expectedRevision: number;
      commandId?: string;
    },
  ): Promise<V2InputRemovedFrame>;
  resumeFollowUps(
    client: MobileTestHarnessV2Client,
    input: {
      conversationId: string;
      expectedQueueRevision: number;
      commandId?: string;
    },
  ): Promise<V2QueueResumedFrame>;
  cancelRun(client: MobileTestHarnessV2Client, runId: string): Promise<V2DoneFrame>;
  holdProviderGate(runId: string, gate: MobileTestHarnessProviderGate): void;
  waitForProviderGate(runId: string, gate: MobileTestHarnessProviderGate): Promise<void>;
  releaseProviderGate(runId: string, gate: MobileTestHarnessProviderGate): void;
  failRun(runId: string): void;
  providerExecutions(conversationId: string): Promise<MobileTestHarnessProviderExecutions>;
  providerExecutionCount(input: {
    conversationId: string;
    runId?: string;
    inputId?: string;
  }): Promise<number>;
  runtimeResourceCounts(): { created: number; closed: number };
  stopGateway(): Promise<void>;
  restartGateway(): Promise<void>;
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

interface ProviderGateState {
  held: boolean;
  reached: boolean;
  reachedSignal: Deferred<void>;
  releaseSignal: Deferred<void>;
}

class MobileHarnessProviderController {
  private readonly gates = new Map<string, ProviderGateState>();
  private readonly failingRuns = new Set<string>();
  private readonly executions = new Map<
    string,
    MobileTestHarnessProviderExecution & {
      conversationId: string;
    }
  >();

  private gateKey(runId: string, gate: MobileTestHarnessProviderGate): string {
    return `${runId}\u0000${gate}`;
  }

  private gate(runId: string, gate: MobileTestHarnessProviderGate): ProviderGateState {
    const key = this.gateKey(runId, gate);
    let state = this.gates.get(key);
    if (!state) {
      state = {
        held: false,
        reached: false,
        reachedSignal: deferred<void>(),
        releaseSignal: deferred<void>(),
      };
      this.gates.set(key, state);
    }
    return state;
  }

  hold(runId: string, gate: MobileTestHarnessProviderGate): void {
    const state = this.gate(runId, gate);
    if (state.reached && !state.held) {
      throw new Error(`Provider gate ${gate} for ${runId} was already passed`);
    }
    state.held = true;
  }

  async reach(
    runId: string,
    gate: MobileTestHarnessProviderGate,
    aborted: Promise<void>,
  ): Promise<boolean> {
    const state = this.gate(runId, gate);
    state.reached = true;
    state.reachedSignal.resolve();
    if (!state.held) return true;
    return Promise.race([state.releaseSignal.promise.then(() => true), aborted.then(() => false)]);
  }

  waitFor(runId: string, gate: MobileTestHarnessProviderGate): Promise<void> {
    return this.gate(runId, gate).reachedSignal.promise;
  }

  release(runId: string, gate: MobileTestHarnessProviderGate): void {
    this.gate(runId, gate).releaseSignal.resolve();
  }

  failRun(runId: string): void {
    this.failingRuns.add(runId);
  }

  shouldFail(runId: string): boolean {
    return this.failingRuns.delete(runId);
  }

  recordExecution(conversationId: string, runId: string, inputId: string | null): void {
    const key = `${conversationId}\u0000${runId}\u0000${inputId ?? ''}`;
    const existing = this.executions.get(key);
    if (existing) {
      existing.count += 1;
      return;
    }
    this.executions.set(key, { conversationId, runId, inputId, count: 1 });
  }

  listExecutions(conversationId: string): MobileTestHarnessProviderExecutions {
    return {
      executions: [...this.executions.values()]
        .filter((execution) => execution.conversationId === conversationId)
        .map(({ runId, inputId, count }) => ({ runId, inputId, count })),
    };
  }
}

class MobileHarnessV2Client implements MobileTestHarnessV2Client {
  readonly frames: MobileV2WsServerFrame[] = [];
  private readonly listeners = new Set<() => void>();
  private validationError: Error | undefined;
  lastV2Seq = 0;

  constructor(private readonly socket: WebSocket) {
    socket.addEventListener('message', (event) => {
      try {
        const parsed = JSON.parse(String(event.data)) as unknown;
        const frame = requireValidV2<MobileV2WsServerFrame>(
          validateV2ServerFrame,
          parsed,
          'WebSocket frame',
        );
        this.frames.push(frame);
        if ('v2Seq' in frame) this.lastV2Seq = Math.max(this.lastV2Seq, frame.v2Seq);
      } catch (error) {
        this.validationError = error instanceof Error ? error : new Error(String(error));
      }
      for (const listener of this.listeners) listener();
    });
  }

  send(frame: MobileV2WsClientFrame): void {
    this.socket.send(JSON.stringify(frame));
  }

  async waitFor(
    predicate: (frame: MobileV2WsServerFrame) => boolean,
    options: { afterV2Seq?: number } = {},
  ): Promise<MobileV2WsServerFrame> {
    const find = (): MobileV2WsServerFrame | undefined =>
      this.frames.find((frame) => {
        if (
          options.afterV2Seq !== undefined &&
          (!('v2Seq' in frame) || frame.v2Seq <= options.afterV2Seq)
        ) {
          return false;
        }
        return predicate(frame);
      });
    if (this.validationError) throw this.validationError;
    const existing = find();
    if (existing) return existing;
    return new Promise<MobileV2WsServerFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(check);
        reject(
          this.validationError ??
            new Error(`Timed out waiting for v2 frame after sequence ${this.lastV2Seq}`),
        );
      }, 5_000);
      const check = (): void => {
        const validationError = this.validationError;
        const frame = find();
        if (!frame && !validationError) return;
        clearTimeout(timer);
        this.listeners.delete(check);
        if (validationError) reject(validationError);
        else resolve(frame as MobileV2WsServerFrame);
      };
      this.listeners.add(check);
    });
  }

  async waitForV2Seq(v2Seq: number): Promise<void> {
    if (this.validationError) throw this.validationError;
    if (this.lastV2Seq >= v2Seq) return;
    await this.waitFor((frame) => 'v2Seq' in frame && frame.v2Seq >= v2Seq);
  }

  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    if (this.socket.readyState === WebSocket.CLOSING) {
      await new Promise<void>((resolve) => {
        this.socket.addEventListener('close', () => resolve(), { once: true });
      });
      return;
    }
    const closed = new Promise<void>((resolve) => {
      this.socket.addEventListener('close', () => resolve(), { once: true });
    });
    this.socket.close();
    await closed;
  }
}

class ScriptedMobileBackend implements AgentBackend {
  readonly name = 'mobile-test-scripted';
  private stopped = false;
  private activeAbort: Deferred<void> | null = null;
  private activeAnswer: Deferred<string> | null = null;
  private activeSteering:
    | {
        runId: string;
        sealed: boolean;
        inputs: Array<{ inputId: string; content: SteerContent }>;
      }
    | undefined;

  constructor(
    private readonly scenario: MobileTestHarnessScenario,
    private readonly slowEventRelease: Promise<void>,
    private readonly provider: MobileHarnessProviderController,
    private readonly inputIdForRun: (conversationId: string, runId: string) => string | null,
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

  async steer(runId: string, inputId: string, content: SteerContent): Promise<SteerResult> {
    const active = this.activeSteering;
    if (!active) return { accepted: false, reason: 'idle' };
    if (active.runId !== runId) return { accepted: false, reason: 'run_mismatch' };
    if (active.sealed) return { accepted: false, reason: 'sealed' };
    active.inputs.push({ inputId, content });
    return { accepted: true };
  }

  async sealSteering(runId: string): Promise<string[]> {
    const active = this.activeSteering;
    if (!active || active.runId !== runId) return [];
    active.sealed = true;
    const inputIds = active.inputs.map((input) => input.inputId);
    active.inputs = [];
    this.abort();
    return inputIds;
  }

  async reconcileSteers(): Promise<void> {}

  async answerQuestion(id: string, answers: string[][]): Promise<void> {
    if (id !== 'question-01' || !this.activeAnswer) return;
    this.activeAnswer.resolve(answers[0]?.[0] ?? '');
  }

  async *run(state: AgentState, options: RunOptions): AsyncGenerator<AgentEvent> {
    if (this.stopped) return;
    const aborted = deferred<void>();
    this.activeAbort = aborted;
    try {
      if (
        (this.scenario === 'follow-up-v2' || this.scenario === 'follow-up-v2-restart') &&
        options.runId
      ) {
        const runId = options.runId;
        const activeSteering: NonNullable<ScriptedMobileBackend['activeSteering']> = {
          runId,
          sealed: false,
          inputs: [],
        };
        this.activeSteering = activeSteering;
        if ((await options.onRunReadyForSteering?.()) === 'sealed') return;
        const promotedInputId = this.inputIdForRun(state.conversationId, runId);
        if (promotedInputId) {
          if (!(await this.provider.reach(runId, 'afterFollowUpClaim', aborted.promise))) return;
        } else {
          this.provider.hold(runId, 'beforeSafeBoundary');
        }
        if (!(await this.provider.reach(runId, 'beforeProviderStart', aborted.promise))) return;
        this.provider.recordExecution(state.conversationId, runId, promotedInputId);
        yield { type: 'text_delta', text: 'Starting Follow Up v2 fixture' };
        if (!(await this.provider.reach(runId, 'beforeSafeBoundary', aborted.promise))) return;

        while (activeSteering.inputs.length > 0 && !activeSteering.sealed) {
          const steer = activeSteering.inputs.shift();
          if (!steer) break;
          await options.onSteerConsumed?.(steer.inputId);
          if (!(await this.provider.reach(runId, 'afterSqliteDelivery', aborted.promise))) return;
          if (!(await this.provider.reach(runId, 'beforePiMessagePersist', aborted.promise)))
            return;
          this.provider.recordExecution(state.conversationId, runId, steer.inputId);
          yield { type: 'text_delta', text: 'Steered continuation' };
        }

        if (!(await this.provider.reach(runId, 'beforeRunTerminal', aborted.promise))) return;
        if (this.provider.shouldFail(runId)) {
          throw new Error('Scripted Follow Up v2 provider failure');
        }
        yield {
          type: 'response',
          content: 'Follow Up v2 fixture complete',
          usage: { inputTokens: 3, outputTokens: 4 },
        };
        return;
      }

      if ((await options.onRunReadyForSteering?.()) === 'sealed') return;
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
      if (this.activeSteering?.runId === options.runId) this.activeSteering = undefined;
      this.activeAnswer = null;
    }
  }
}

interface OwnedServer {
  server: Server;
  close(): Promise<void>;
}

async function listen<E extends Env>(
  app: Hono<E>,
  injectWebSocket: (server: Server) => void,
  tls?: { privateKey: string; certificate: string },
  port = 0,
): Promise<OwnedServer> {
  const server = serve(
    tls
      ? {
          fetch: app.fetch,
          hostname: '127.0.0.1',
          port,
          createServer: createHttpsServer,
          serverOptions: { key: tls.privateKey, cert: tls.certificate },
        }
      : { fetch: app.fetch, hostname: '127.0.0.1', port },
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

interface MobileHarnessPorts {
  management: number;
  chat: number;
  lan: number;
}

interface MobileHarnessRuntime {
  agentId: string;
  ports: MobileHarnessPorts;
  stop(): Promise<void>;
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
  const publicKey = options.publicKey ?? 'mobile-test-public-key';
  const provider = new MobileHarnessProviderController();
  const providerGates = new Set<MobileTestHarnessProviderGate>([
    'beforeSafeBoundary',
    'afterSqliteDelivery',
    'beforeProviderStart',
    'beforePiMessagePersist',
    'beforeRunTerminal',
    'afterFollowUpClaim',
  ]);
  let failSteerDelivery = options.failSteerDeliveryOnce === true;
  let failRestartAfterManagementListen = options.failRestartOnceAfterManagementListen === true;
  let failRestartDuringInitialization = options.failRestartOnceDuringInitialization === true;
  let runtimeResourcesCreated = 0;
  let runtimeResourcesClosed = 0;

  const createRuntime = async (
    requestedPorts?: MobileHarnessPorts,
  ): Promise<MobileHarnessRuntime> => {
    let cleanupInitialization = async (): Promise<void> => {};
    try {
      const logger = new StructuredLoggerImpl('error', []);
      let loggerClosed = false;
      const closeLogger = async (): Promise<void> => {
        if (loggerClosed) return;
        loggerClosed = true;
        await logger.close();
      };
      cleanupInitialization = closeLogger;
      const agentRegistry = new AgentRegistry(join(dataDir, 'agents.json'));
      const channelRegistry = new ChannelRegistry(join(dataDir, 'channels.json'));
      const credentialStore = new GatewayCredentialStore(dataDir);
      const modelsStore = new ModelsStore(dataDir);
      const conversations = new SqliteConversationService({ dataDir });
      runtimeResourcesCreated += 1;
      let conversationsClosed = false;
      const markConversationsClosed = (): void => {
        if (conversationsClosed) return;
        conversationsClosed = true;
        runtimeResourcesClosed += 1;
      };
      const closeConversations = (): void => {
        if (conversationsClosed) return;
        conversations.close();
        markConversationsClosed();
      };
      cleanupInitialization = async () => {
        closeConversations();
        await closeLogger();
      };
      if (failSteerDelivery) {
        const deliverSteer = conversations.deliverSteer.bind(conversations);
        conversations.deliverSteer = (input) => {
          if (failSteerDelivery) {
            failSteerDelivery = false;
            throw new Error('Injected harness Steer delivery failure');
          }
          return deliverSteer(input);
        };
      }
      const eventBus = new EventBus();
      const admission = new GatewayAdmissionController();
      const gateway = createDynamicGateway({ dataDir, admission });
      const slowEventRelease = deferred<void>();
      const runtimeState: {
        managementServer?: OwnedServer;
        chatServer?: OwnedServer;
        lanServer?: OwnedServer;
        directChatLifecycle?: ChatWsLifecycle;
        lanChatLifecycle?: ChatWsLifecycle;
        shutdownCoordinator?: GatewayShutdownCoordinator;
      } = {};
      let stopped: Promise<void> | undefined;

      await credentialStore.init();
      if (requestedPorts && failRestartDuringInitialization) {
        failRestartDuringInitialization = false;
        throw new Error('Injected harness initialization failure');
      }
      await agentRegistry.load();
      for (const entry of agentRegistry.list()) {
        if (entry.status === 'disabled' || entry.deletionIntent) admission.closeAgent(entry.id);
      }
      const restoredAgent = agentRegistry
        .list()
        .find((entry) => entry.name === 'mobile-test-agent');
      let registered =
        restoredAgent ??
        agentRegistry.register({
          name: 'mobile-test-agent',
          model: 'test/scripted',
          systemPrompt: 'Deterministic mobile contract test agent.',
        });
      if (!restoredAgent) await agentRegistry.save();

      const gatewayRecovery = recoverGatewayTurns({
        eventLog: conversations.eventLog,
        conversations,
        admission,
        isDeletionMarked: (agentId) => agentRegistry.get(agentId)?.deletionIntent === true,
      });
      for (const entry of agentRegistry.list()) {
        if (entry.status === 'disabled') conversations.pauseFollowUpsForAgentDisable(entry.id);
      }

      const inputIdForRun = (conversationId: string, runId: string): string | null => {
        const conversation = conversations.get(conversationId, { includeDeleted: true });
        if (!conversation) return null;
        const delivered = conversations
          .readV2Since(conversation.agentId, conversationId, 0)
          .frames.findLast((frame) => frame.type === 'input_delivered' && frame.runId === runId);
        return delivered?.type === 'input_delivered' ? delivered.input.inputId : null;
      };
      const agents = createAgentChatCoordinator({
        registry: agentRegistry,
        admission,
        poolMaxSize: 32,
        memoryDir: (agentId) => join(dataDir, 'memory', agentId),
        createBackend: async () =>
          new ScriptedMobileBackend(scenario, slowEventRelease.promise, provider, inputIdForRun),
      });
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
        admission,
        isAgentEnabled: (agentId) => {
          const entry = agentRegistry.get(agentId);
          return entry !== undefined && entry.status !== 'disabled' && !entry.deletionIntent;
        },
        onChanged: (summary) =>
          eventBus.emit({
            type: 'conversation:changed',
            conversationId: summary.id,
            revision: summary.revision,
          }),
      });

      const stopRuntime = (): Promise<void> => {
        stopped ??= (async () => {
          let shutdownFailure: { error: unknown } | undefined;
          const attempt = async (operation: () => Promise<void>): Promise<void> => {
            try {
              await operation();
            } catch (error) {
              shutdownFailure ??= { error };
            }
          };
          const coordinator = runtimeState.shutdownCoordinator;
          if (coordinator) {
            await attempt(() => coordinator.shutdown().completion);
            if (!shutdownFailure) {
              markConversationsClosed();
            }
          } else {
            await attempt(() => hub.stop());
            await attempt(() => autoTitle.flush());
            await attempt(() => agents.stop());
            await attempt(() => gateway.stop());
          }
          if (!conversationsClosed) {
            try {
              closeConversations();
            } catch (error) {
              shutdownFailure ??= { error };
            }
          }
          const cleanupResults = await Promise.allSettled([
            closeServer(runtimeState.managementServer),
            closeServer(runtimeState.chatServer),
            closeServer(runtimeState.lanServer),
            closeLogger(),
          ]);
          const cleanupFailure = cleanupResults.find(
            (result): result is PromiseRejectedResult => result.status === 'rejected',
          );
          if (shutdownFailure) throw shutdownFailure.error;
          if (cleanupFailure) throw cleanupFailure.reason;
        })();
        return stopped;
      };
      cleanupInitialization = stopRuntime;

      await resumePendingAgentDeletions(
        {
          gateway,
          agents,
          agentRegistry,
          channelRegistry,
          conversationService: conversations,
          resumableChatHub: hub,
          admission,
          eventBus,
        },
        { excludeConversationIds: gatewayRecovery.excludedConversationIds },
      );
      if (!agentRegistry.get(registered.id)) {
        registered = agentRegistry.register({
          name: 'mobile-test-agent',
          model: 'test/scripted',
          systemPrompt: 'Deterministic mobile contract test agent.',
        });
        await agentRegistry.save();
      }

      for (const entry of agentRegistry.list()) {
        if (entry.status === 'disabled' || entry.deletionIntent) continue;
        const agentId = entry.id;
        gateway.registerAgent(agentId, {
          chat(channelId, conversationId, text, runOptions) {
            return agents.chat({
              agentId,
              channelId,
              conversationId,
              text,
              signal: runOptions?.signal,
            });
          },
          listSkills() {
            return agents.listSkills(agentId);
          },
        });
      }
      await hub.resumeRecoveredQueues(
        gatewayRecovery.conversations.eligibleConversationIds.filter((conversationId) => {
          const conversation = conversations.get(conversationId);
          if (!conversation) return false;
          const entry = agentRegistry.get(conversation.agentId);
          return entry !== undefined && entry.status !== 'disabled' && !entry.deletionIntent;
        }),
      );
      await gateway.start();

      const lanTls = await loadOrCreateLanTlsIdentity(dataDir, ['127.0.0.1']);
      const managementApp = createGatewayManagementApp({
        gateway,
        agents,
        agentRegistry,
        channelRegistry,
        identity: { gatewayId, publicKey },
        credentialStore,
        modelsStore,
        conversationService: conversations,
        resumableChatHub: hub,
        admission,
        mobileToken: chatToken,
        token: managementToken,
        lanTlsFingerprint: lanTls.fingerprint,
        startedAt: '2026-07-12T00:00:00.000Z',
        eventBus,
        logger,
        onShutdown: (ownerLease) => {
          const coordinator = runtimeState.shutdownCoordinator;
          if (!coordinator) throw new Error('Mobile test harness shutdown is not ready');
          return coordinator.shutdown(ownerLease);
        },
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
      managementApp.get('/mobile/v2/__mobile-test/provider-executions', (context) => {
        const conversationId = context.req.query('conversationId');
        if (!conversationId) {
          return context.json({ error: 'conversationId is required' }, 400);
        }
        return context.json(provider.listExecutions(conversationId));
      });
      managementApp.post('/mobile/v2/__mobile-test/provider-runs/fail', async (context) => {
        const body = (await context.req.json().catch(() => null)) as { runId?: unknown } | null;
        if (!body || typeof body.runId !== 'string' || body.runId.trim().length === 0) {
          return context.json({ error: 'Invalid provider failure control' }, 400);
        }
        provider.failRun(body.runId);
        return context.json({ ok: true });
      });
      managementApp.post('/mobile/v2/__mobile-test/provider-gates/:action', async (context) => {
        const body = (await context.req.json().catch(() => null)) as {
          runId?: unknown;
          gate?: unknown;
        } | null;
        if (
          !body ||
          typeof body.runId !== 'string' ||
          typeof body.gate !== 'string' ||
          !providerGates.has(body.gate as MobileTestHarnessProviderGate)
        ) {
          return context.json({ error: 'Invalid provider gate control' }, 400);
        }
        const gate = body.gate as MobileTestHarnessProviderGate;
        if (context.req.param('action') === 'hold') provider.hold(body.runId, gate);
        else if (context.req.param('action') === 'release') provider.release(body.runId, gate);
        else return context.json({ error: 'Invalid provider gate action' }, 400);
        return context.json({ ok: true });
      });
      const wsTickets = mountWsTicketRoute(managementApp);

      const exposedManagementApp =
        scenario === 'follow-up-v1-fallback'
          ? new Hono()
              .all('/mobile/v2', (context) => context.notFound())
              .all('/mobile/v2/*', (context) => context.notFound())
          : managementApp;
      if (exposedManagementApp !== managementApp) {
        exposedManagementApp.all('*', (context) => managementApp.fetch(context.req.raw));
      }
      const managementWebSocket = createNodeWebSocket({ app: exposedManagementApp });

      const chatApp = new Hono();
      const chatWebSocket = createNodeWebSocket({ app: chatApp });
      runtimeState.directChatLifecycle = mountChatWs(chatApp, {
        agents,
        resumableChatHub: hub,
        admission,
        token: chatToken,
        upgradeWebSocket: chatWebSocket.upgradeWebSocket,
        eventLogStore: conversations.eventLog,
        verbose: false,
        wsTickets,
      });

      const lanApp = createLanMobileApp(exposedManagementApp);
      const lanWebSocket = createNodeWebSocket({ app: lanApp });
      runtimeState.lanChatLifecycle = mountChatWs(lanApp, {
        agents,
        resumableChatHub: hub,
        admission,
        token: chatToken,
        upgradeWebSocket: lanWebSocket.upgradeWebSocket,
        eventLogStore: conversations.eventLog,
        verbose: false,
        wsTickets,
      });

      runtimeState.shutdownCoordinator = createGatewayShutdownCoordinator({
        admission,
        resumableChatHub: hub,
        getChatLifecycles: () =>
          [runtimeState.directChatLifecycle, runtimeState.lanChatLifecycle].filter(
            (lifecycle): lifecycle is ChatWsLifecycle => lifecycle !== undefined,
          ),
        getProjectsLifecycle: () => undefined,
        mcpManager: { stop() {} },
        swarmCoordinator: { stop() {} },
        agents,
        gateway,
        backgroundFlushes: [
          { label: 'conversationAutoTitle.flush', flush: () => autoTitle.flush() },
        ],
        getManagementServer: () => runtimeState.managementServer?.server,
        getChannelServer: () => runtimeState.chatServer?.server,
        getLanServer: () => runtimeState.lanServer?.server,
        projectsDb: { close() {} },
        conversationService: conversations,
        timeoutMs: 100,
      });

      runtimeState.managementServer = await listen(
        exposedManagementApp,
        managementWebSocket.injectWebSocket,
        undefined,
        requestedPorts?.management,
      );
      if (requestedPorts && failRestartAfterManagementListen) {
        failRestartAfterManagementListen = false;
        throw new Error('Injected harness restart failure');
      }
      runtimeState.chatServer = await listen(
        chatApp,
        chatWebSocket.injectWebSocket,
        undefined,
        requestedPorts?.chat,
      );
      runtimeState.lanServer = await listen(
        lanApp,
        lanWebSocket.injectWebSocket,
        lanTls,
        requestedPorts?.lan,
      );

      return {
        agentId: registered.id,
        ports: {
          management: portOf(runtimeState.managementServer),
          chat: portOf(runtimeState.chatServer),
          lan: portOf(runtimeState.lanServer),
        },
        stop: stopRuntime,
      };
    } catch (error) {
      await cleanupInitialization().catch(() => undefined);
      throw error;
    }
  };

  let runtime: MobileHarnessRuntime | undefined = await createRuntime();
  const stablePorts = runtime.ports;
  const stableAgentId = runtime.agentId;
  const managementBaseUrl = `http://127.0.0.1:${stablePorts.management}`;
  const chatWebSocketUrl = `ws://127.0.0.1:${stablePorts.chat}/ws/chat`;
  const mobileBaseUrl = `https://127.0.0.1:${stablePorts.lan}`;
  const mobileChatWebSocketUrl = `wss://127.0.0.1:${stablePorts.lan}/ws/chat`;
  const lanTls = await loadOrCreateLanTlsIdentity(dataDir, ['127.0.0.1']);

  const expectReply = async <T extends MobileV2WsServerFrame>(
    client: MobileTestHarnessV2Client,
    commandId: string,
    type: T['type'],
  ): Promise<T> => {
    const frame = await client.waitFor(
      (candidate) =>
        'id' in candidate &&
        candidate.id === commandId &&
        (candidate.type === type || candidate.type === 'command_rejected'),
    );
    if (frame.type === 'command_rejected') {
      throw new Error(`Harness command ${commandId} rejected with ${frame.code}`);
    }
    return frame as T;
  };

  const connectV2: RunningMobileTestHarness['connectV2'] = async (connection = {}) => {
    const socket = new WebSocket(
      `${connection.webSocketUrl ?? chatWebSocketUrl}?token=${encodeURIComponent(
        connection.token ?? chatToken,
      )}`,
      { rejectUnauthorized: connection.rejectUnauthorized ?? false },
    );
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', (event) => reject(event.error), { once: true });
    });
    const client = new MobileHarnessV2Client(socket);
    client.send({
      type: 'hello',
      contractVersion: 2,
      capabilities: ['chat-input-queue-v1'],
    });
    await client.waitFor((frame) => frame.type === 'hello_ack');
    return client;
  };

  const bootstrapV2: RunningMobileTestHarness['bootstrapV2'] = async (conversationId) => {
    const response = await fetch(
      `${managementBaseUrl}/mobile/v2/conversations/${encodeURIComponent(conversationId)}/bootstrap`,
      { headers: { Authorization: `Bearer ${chatToken}` } },
    );
    if (!response.ok) throw new Error(`Harness bootstrap failed with HTTP ${response.status}`);
    return requireValidV2<MobileV2ConversationBootstrap>(
      validateV2Bootstrap,
      await response.json(),
      'Bootstrap response',
    );
  };

  const subscribeConversation: RunningMobileTestHarness['subscribeConversation'] = async (
    client,
    input,
  ) => {
    const commandId = input.commandId ?? randomUUID();
    client.send({
      type: 'subscribe_conversation',
      id: commandId,
      agentId: input.agentId ?? stableAgentId,
      conversationId: input.conversationId,
      sinceV2Seq: input.sinceV2Seq ?? 0,
    });
    return expectReply<V2SubscribedFrame>(client, commandId, 'conversation_subscribed');
  };

  const enqueueInput: RunningMobileTestHarness['enqueueInput'] = async (client, input) => {
    const commandId = input.commandId ?? randomUUID();
    client.send({
      type: 'enqueue_input',
      id: commandId,
      inputId: input.inputId ?? randomUUID(),
      agentId: input.agentId ?? stableAgentId,
      channelId: input.channelId ?? 'mobile-test-harness',
      conversationId: input.conversationId,
      text: input.text,
      ...(input.images !== undefined ? { images: input.images } : {}),
      behavior: input.behavior,
      ...(input.expectedActiveTurnId !== undefined
        ? { expectedActiveTurnId: input.expectedActiveTurnId }
        : {}),
    });
    return expectReply<V2InputAcceptedFrame>(client, commandId, 'input_accepted');
  };

  const editFollowUp: RunningMobileTestHarness['editFollowUp'] = async (client, input) => {
    const commandId = input.commandId ?? randomUUID();
    client.send({
      type: 'edit_follow_up',
      id: commandId,
      conversationId: input.conversationId,
      inputId: input.inputId,
      expectedRevision: input.expectedRevision,
      text: input.text,
      ...(input.images !== undefined ? { images: input.images } : {}),
    });
    return expectReply<V2InputUpdatedFrame>(client, commandId, 'input_updated');
  };

  const removeFollowUp: RunningMobileTestHarness['removeFollowUp'] = async (client, input) => {
    const commandId = input.commandId ?? randomUUID();
    client.send({
      type: 'remove_follow_up',
      id: commandId,
      conversationId: input.conversationId,
      inputId: input.inputId,
      expectedRevision: input.expectedRevision,
    });
    return expectReply<V2InputRemovedFrame>(client, commandId, 'input_removed');
  };

  const resumeFollowUps: RunningMobileTestHarness['resumeFollowUps'] = async (client, input) => {
    const commandId = input.commandId ?? randomUUID();
    client.send({
      type: 'resume_follow_ups',
      id: commandId,
      conversationId: input.conversationId,
      expectedQueueRevision: input.expectedQueueRevision,
    });
    return expectReply<V2QueueResumedFrame>(client, commandId, 'queue_resumed');
  };

  const cancelRun: RunningMobileTestHarness['cancelRun'] = async (client, runId) => {
    const afterV2Seq = client.lastV2Seq;
    client.send({ type: 'cancel', id: runId });
    return (await client.waitFor((frame) => frame.type === 'done' && frame.runId === runId, {
      afterV2Seq,
    })) as V2DoneFrame;
  };

  const providerExecutions: RunningMobileTestHarness['providerExecutions'] = async (
    conversationId,
  ) => {
    const response = await fetch(
      `${managementBaseUrl}/mobile/v2/__mobile-test/provider-executions?conversationId=${encodeURIComponent(
        conversationId,
      )}`,
      { headers: { Authorization: `Bearer ${chatToken}` } },
    );
    if (!response.ok) {
      throw new Error(`Harness provider execution query failed with HTTP ${response.status}`);
    }
    const value = (await response.json()) as MobileTestHarnessProviderExecutions;
    if (
      !value ||
      Object.keys(value).sort().join(',') !== 'executions' ||
      !Array.isArray(value.executions) ||
      value.executions.some(
        (execution) =>
          Object.keys(execution).sort().join(',') !== 'count,inputId,runId' ||
          typeof execution.runId !== 'string' ||
          (execution.inputId !== null && typeof execution.inputId !== 'string') ||
          !Number.isSafeInteger(execution.count) ||
          execution.count < 0,
      )
    ) {
      throw new Error('Harness provider execution response is invalid');
    }
    return value;
  };

  const stopGateway = async (): Promise<void> => {
    const current = runtime;
    if (!current) return;
    try {
      await current.stop();
    } finally {
      if (runtime === current) runtime = undefined;
    }
  };

  const restartGateway = async (): Promise<void> => {
    await stopGateway();
    const next = await createRuntime(stablePorts);
    if (next.agentId !== stableAgentId) {
      await next.stop();
      throw new Error('Mobile test harness agent identity changed during restart');
    }
    runtime = next;
  };

  let finalStop: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    finalStop ??= (async () => {
      await stopGateway();
      if (ownsDataDir) await rm(dataDir, { recursive: true, force: true });
    })();
    return finalStop;
  };

  return {
    managementBaseUrl,
    chatWebSocketUrl,
    mobileBaseUrl,
    mobileChatWebSocketUrl,
    tlsCertificateSha256: lanTls.fingerprint,
    managementToken,
    chatToken,
    gatewayId,
    publicKey,
    agentId: stableAgentId,
    dataDir,
    connectV2,
    bootstrapV2,
    subscribeConversation,
    enqueueInput,
    editFollowUp,
    removeFollowUp,
    resumeFollowUps,
    cancelRun,
    holdProviderGate: (runId, gate) => provider.hold(runId, gate),
    waitForProviderGate: (runId, gate) => provider.waitFor(runId, gate),
    releaseProviderGate: (runId, gate) => provider.release(runId, gate),
    failRun: (runId) => provider.failRun(runId),
    providerExecutions,
    providerExecutionCount: async (input) => {
      const output = await providerExecutions(input.conversationId);
      return output.executions
        .filter(
          (execution) =>
            (input.runId === undefined || execution.runId === input.runId) &&
            (input.inputId === undefined || execution.inputId === input.inputId),
        )
        .reduce((total, execution) => total + execution.count, 0);
    },
    runtimeResourceCounts: () => ({
      created: runtimeResourcesCreated,
      closed: runtimeResourcesClosed,
    }),
    stopGateway,
    restartGateway,
    stop,
  };
}
