import { mkdir, readFile, rm } from 'node:fs/promises';
// @vitest-environment node
// Override jsdom (set in vitest.config.ts for this package). Needs Node for WebSocketServer and filesystem I/O.
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ConversationRepositoryOfflineError,
  ConversationStore,
  GatewayHttpError,
  LegacyConversationRepository,
} from '@dash/mc';
import type { ConversationRef, McConversationView } from '@dash/mc';
import type { MobileWsServerFrame } from '@dash/mobile-contract';
import type {
  MobileV2ConversationBootstrap,
  MobileV2ConversationMessagePage,
  MobileV2SequencedFrame,
} from '@dash/mobile-contract-v2';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { ConversationChatSupersededError } from '../shared/ipc.js';
import type { GatewayConnection } from './chat-service.js';
import { ChatService } from './chat-service.js';
import {
  ConversationChatCommandError,
  ConversationChatTransport,
} from './conversation-chat-transport.js';
import { ConversationController } from './conversation-controller.js';
import type { ResumableChatTransport } from './resumable-chat-transport.js';
import { FixtureGatewayConversationRepository } from './test-support/fixture-gateway-conversation-repository.js';

const BASE_PORT = 19700 + Math.floor(Math.random() * 200);
const LEGACY_REQUEST_ID = 'legacy-request';
const LEGACY_TURN_ID = 'legacy-turn';

function localRef(id: string): ConversationRef {
  return { id, origin: 'local' };
}

function createLocal(service: ChatService, agentId: string) {
  return service.createConversation(agentId, LEGACY_REQUEST_ID);
}

function sendLocal(
  service: ChatService,
  conversationId: string,
  text: string,
  images?: Array<{ mediaType: 'image/png'; data: string }>,
) {
  return service.sendMessage(localRef(conversationId), LEGACY_TURN_ID, text, images);
}

async function localMessages(service: ChatService, conversationId: string) {
  return (await service.getMessages(localRef(conversationId))).items;
}

async function fixture<T>(name: string): Promise<T> {
  const root = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../../../contracts/mobile/v1/fixtures',
  );
  return JSON.parse(await readFile(resolve(root, name), 'utf8')) as T;
}

async function fixtureV2<T>(name: string): Promise<T> {
  const root = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../../../contracts/mobile/v2/fixtures',
  );
  return JSON.parse(await readFile(resolve(root, name), 'utf8')) as T;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe('ChatService', () => {
  let dataDir: string;
  let store: ConversationStore;
  let wss: WebSocketServer | undefined;
  let onEvent: ReturnType<typeof vi.fn>;
  let onDone: ReturnType<typeof vi.fn>;
  let onError: ReturnType<typeof vi.fn>;
  let onSessionStatus: ReturnType<typeof vi.fn>;
  let service: ChatService;

  function makeService(port: number, token?: string): ChatService {
    const gw: GatewayConnection = { channelPort: port, chatToken: token };
    const svc = new ChatService(store, onEvent, onDone, onError, gw);
    svc.setSessionStatusListener(onSessionStatus);
    return svc;
  }

  beforeEach(async () => {
    dataDir = join(tmpdir(), `chat-service-test-${Date.now()}`);
    await mkdir(dataDir, { recursive: true });
    store = new ConversationStore(dataDir);
    onEvent = vi.fn();
    onDone = vi.fn();
    onError = vi.fn();
    onSessionStatus = vi.fn();
    service = makeService(BASE_PORT);
  });

  afterEach(async () => {
    if (wss) {
      await new Promise<void>((r) => wss?.close(() => r()));
      wss = undefined;
    }
    await rm(dataDir, { recursive: true, force: true });
  });

  it('creates and lists conversations', async () => {
    const conv = await createLocal(service, 'agent-1');
    expect(conv.agentId).toBe('agent-1');
    const list = await service.listConversations();
    expect(list.items).toHaveLength(1);
  });

  it('applies canonical task metadata on the controller-free legacy create path', async () => {
    const created = await service.createConversation('agent-1', 'request-task', {
      title: 'TASK-1 — Fix it',
      owningIssueId: 'issue-1',
      projectId: 'project-1',
    });

    expect(created).toMatchObject({
      title: 'TASK-1 — Fix it',
      owningIssueId: 'issue-1',
      origin: 'local',
    });
    await expect(store.get(created.id)).resolves.toMatchObject({
      title: 'TASK-1 — Fix it',
      issueId: 'issue-1',
    });
  });

  it('sends user message then streams events and done', async () => {
    const port = BASE_PORT + 100;
    service = makeService(port);

    wss = new WebSocketServer({ port });
    wss.on('connection', (ws) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw));
        ws.send(
          JSON.stringify({
            type: 'event',
            id: msg.id,
            event: { type: 'text_delta', text: 'Hi' },
          }),
        );
        ws.send(JSON.stringify({ type: 'done', id: msg.id }));
      });
    });
    await new Promise<void>((r) => wss?.on('listening', r));

    const conv = await createLocal(service, 'agent-1');
    await sendLocal(service, conv.id, 'hello');

    // Wait for async WS event processing
    await new Promise((r) => setTimeout(r, 100));

    expect(onEvent).toHaveBeenCalledWith(conv.id, { type: 'text_delta', text: 'Hi' });
    expect(onDone).toHaveBeenCalledWith(conv.id);

    // Messages should be persisted
    const msgs = await store.getMessages(conv.id);
    expect(msgs).toHaveLength(2); // user + assistant
    expect(msgs[0].role).toBe('user');
    expect(msgs[1].role).toBe('assistant');
  });

  it('emits onSessionStatus working on send and done when the turn ends', async () => {
    const port = BASE_PORT + 120;
    service = makeService(port);

    wss = new WebSocketServer({ port });
    wss.on('connection', (ws) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw));
        ws.send(
          JSON.stringify({
            type: 'event',
            id: msg.id,
            event: { type: 'text_delta', text: 'Hi' },
          }),
        );
        ws.send(JSON.stringify({ type: 'done', id: msg.id }));
      });
    });
    await new Promise<void>((r) => wss?.on('listening', r));

    const conv = await createLocal(service, 'agent-1');
    await sendLocal(service, conv.id, 'hello');
    await new Promise((r) => setTimeout(r, 100));

    const statuses = onSessionStatus.mock.calls.map((c) => c[1]);
    expect(onSessionStatus.mock.calls[0]).toEqual([conv.id, 'working']);
    expect(statuses).toContain('done');
  });

  it('streams through a remote chatBaseUrl with relay headers', async () => {
    const port = BASE_PORT + 110;
    const seenHeaders: Array<string | string[] | undefined> = [];
    service = new ChatService(store, onEvent, onDone, onError, {
      chatBaseUrl: `ws://localhost:${port}`,
      chatToken: 'chat-token',
      headers: { 'x-dash-relay-credential': 'relay-cred' },
    });

    wss = new WebSocketServer({ port });
    wss.on('connection', (ws, req) => {
      seenHeaders.push(req.headers['x-dash-relay-credential']);
      ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw));
        ws.send(JSON.stringify({ type: 'done', id: msg.id }));
      });
    });
    await new Promise<void>((r) => wss?.on('listening', r));

    const conv = await createLocal(service, 'agent-1');
    await sendLocal(service, conv.id, 'hello');
    await new Promise((r) => setTimeout(r, 100));

    expect(seenHeaders).toEqual(['relay-cred']);
    expect(onDone).toHaveBeenCalledWith(conv.id);
  });

  it('emits onSessionStatus needs on a question event and error on an error frame', async () => {
    const port = BASE_PORT + 130;
    service = makeService(port);

    wss = new WebSocketServer({ port });
    wss.on('connection', (ws) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw));
        ws.send(
          JSON.stringify({
            type: 'event',
            id: msg.id,
            event: { type: 'question', id: 'q1', question: 'Which env?', options: [] },
          }),
        );
        ws.send(JSON.stringify({ type: 'error', id: msg.id, error: 'boom' }));
      });
    });
    await new Promise<void>((r) => wss?.on('listening', r));

    const conv = await createLocal(service, 'agent-1');
    await sendLocal(service, conv.id, 'go');
    await new Promise((r) => setTimeout(r, 100));

    const statuses = onSessionStatus.mock.calls.map((c) => c[1]);
    expect(statuses).toContain('needs');
    expect(statuses).toContain('error');
  });

  it('calls onError when gateway sends error', async () => {
    const port = BASE_PORT + 200;
    service = makeService(port);

    wss = new WebSocketServer({ port });
    wss.on('connection', (ws) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw));
        ws.send(
          JSON.stringify({
            type: 'error',
            id: msg.id,
            error: 'agent exploded',
          }),
        );
      });
    });
    await new Promise<void>((r) => wss?.on('listening', r));

    const conv = await createLocal(service, 'agent-1');
    await sendLocal(service, conv.id, 'hello');
    await new Promise((r) => setTimeout(r, 100));

    expect(onError).toHaveBeenCalledWith(conv.id, 'agent exploded');
  });

  it('throws if gateway connection is not configured', async () => {
    const noGwService = new ChatService(store, onEvent, onDone, onError);
    const conv = await createLocal(noGwService, 'agent-1');
    await expect(sendLocal(noGwService, conv.id, 'hello')).rejects.toThrow(
      'Gateway connection not configured',
    );
  });

  it('cancel closes the active WebSocket', async () => {
    const port = BASE_PORT + 400;
    service = makeService(port);

    let serverWs: import('ws').WebSocket | undefined;
    wss = new WebSocketServer({ port });
    wss.on('connection', (ws) => {
      serverWs = ws;
      ws.on('message', async () => {
        // Hang — never respond
        await new Promise(() => {});
      });
    });
    await new Promise<void>((r) => wss?.on('listening', r));

    const conv = await createLocal(service, 'agent-1');
    // Don't await — sendMessage sets up the WS and returns quickly for a hanging server
    sendLocal(service, conv.id, 'hello').catch(() => {});

    // Give time for WS to open and message to be sent
    await new Promise((r) => setTimeout(r, 50));

    await service.cancel(localRef(conv.id), LEGACY_TURN_ID);

    // Give time for WS close to propagate
    await new Promise((r) => setTimeout(r, 50));

    // After cancel, no more events should fire
    expect(onDone).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();

    void serverWs; // suppress unused variable warning
  });

  it('cancel POSTs the swarm-turn cancel even with no active stream', async () => {
    // Regression: swarm workers outlive the orchestrator stream, so the
    // stop path must not depend on an activeStreams entry existing.
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ cancelled: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const svc = new ChatService(store, onEvent, onDone, onError, {
      channelPort: BASE_PORT,
      managementBaseUrl: 'http://mgmt.test',
      managementToken: 'tok',
    });

    const conv = await createLocal(svc, 'agent-9');
    await svc.cancel(localRef(conv.id), LEGACY_TURN_ID); // no sendMessage — no active stream entry
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        `http://mgmt.test/agents/agent-9/conversations/${conv.id}/swarm/cancel`,
        expect.objectContaining({ method: 'POST' }),
      );
    });
    vi.unstubAllGlobals();
  });

  it('cancel sends a cancel frame before closing (swarm terminalization)', async () => {
    const port = BASE_PORT + 450;
    service = makeService(port);

    const received: Record<string, unknown>[] = [];
    let closed = false;
    wss = new WebSocketServer({ port });
    wss.on('connection', (ws) => {
      ws.on('message', (raw) => {
        received.push(JSON.parse(String(raw)));
        // Never respond — keep the stream active so cancel() has work to do.
      });
      ws.on('close', () => {
        closed = true;
      });
    });
    await new Promise<void>((r) => wss?.on('listening', r));

    const conv = await createLocal(service, 'agent-1');
    sendLocal(service, conv.id, 'hello').catch(() => {});
    await vi.waitFor(() => {
      expect(received.length).toBeGreaterThan(0);
    });
    const msgId = received[0].id;

    await service.cancel(localRef(conv.id), LEGACY_TURN_ID);
    await vi.waitFor(() => {
      expect(closed).toBe(true);
    });

    const cancelFrame = received.find((m) => m.type === 'cancel');
    expect(cancelFrame).toEqual({ type: 'cancel', id: msgId });
  });

  it('answerQuestion sends answer over active WebSocket', async () => {
    const port = BASE_PORT + 500;
    service = makeService(port);

    let receivedAnswer: Record<string, unknown> | undefined;
    wss = new WebSocketServer({ port });
    wss.on('connection', (ws) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw));
        if (msg.type === 'message') {
          // Send a question event, then hang (don't send done)
          ws.send(
            JSON.stringify({
              type: 'event',
              id: msg.id,
              event: { type: 'question', id: 'q-1', question: 'Pick', options: ['A', 'B'] },
            }),
          );
        } else if (msg.type === 'answer') {
          receivedAnswer = msg;
          // Now send done to complete the stream
          ws.send(JSON.stringify({ type: 'done', id: msg.id }));
        }
      });
    });
    await new Promise<void>((r) => wss?.on('listening', r));

    const conv = await createLocal(service, 'agent-1');
    sendLocal(service, conv.id, 'hello').catch(() => {});

    // Wait for question event to arrive
    await vi.waitFor(() => {
      expect(onEvent).toHaveBeenCalledWith(
        conv.id,
        expect.objectContaining({ type: 'question', id: 'q-1' }),
      );
    });

    // Send answer
    await service.answerQuestion(localRef(conv.id), LEGACY_TURN_ID, 'q-1', 'A');

    // Wait for the answer to be received by the mock server
    await vi.waitFor(() => {
      expect(receivedAnswer).toBeDefined();
    });

    expect(receivedAnswer).toMatchObject({
      type: 'answer',
      questionId: 'q-1',
      answer: 'A',
    });
  });

  it('answerQuestion throws if no active stream', async () => {
    await expect(
      service.answerQuestion(localRef('nonexistent'), LEGACY_TURN_ID, 'q-1', 'A'),
    ).rejects.toThrow('No active stream');
  });

  // ------------------------------------------------------------------
  // Event-log replay on unclean WebSocket close
  // ------------------------------------------------------------------

  it('reconciles missing events from the management endpoint on unclean close', async () => {
    // Mock management HTTP server: the chat-ws WebSocket will drop
    // after 1 event; the replay endpoint returns the remaining 2
    // events + a 'done' terminal entry.
    let replayCalls = 0;
    let replaySinceSeqSeen: number | undefined;
    const managementServer: Server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      // The background auto-title POST also lands here; it isn't what this
      // test measures, so 404 it and count only replay requests.
      if (!url.pathname.endsWith('/events')) {
        res.writeHead(404).end();
        return;
      }
      replayCalls++;
      replaySinceSeqSeen = Number(url.searchParams.get('sinceSeq') ?? 'NaN');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          entries: [
            {
              seq: 2,
              msgId: 'mid',
              agentId: 'agent-1',
              conversationId: 'c',
              timestamp: '2026-04-14T00:00:00Z',
              payload: { type: 'event', event: { type: 'text_delta', text: ' world' } },
            },
            {
              seq: 3,
              msgId: 'mid',
              agentId: 'agent-1',
              conversationId: 'c',
              timestamp: '2026-04-14T00:00:00Z',
              payload: {
                type: 'event',
                event: {
                  type: 'response',
                  content: 'hello world',
                  usage: { inputTokens: 1, outputTokens: 2 },
                },
              },
            },
            {
              seq: 4,
              msgId: 'mid',
              agentId: 'agent-1',
              conversationId: 'c',
              timestamp: '2026-04-14T00:00:00Z',
              payload: { type: 'done' },
            },
          ],
        }),
      );
    });
    await new Promise<void>((r) => managementServer.listen(0, '127.0.0.1', r));
    const mgmtAddress = managementServer.address();
    const mgmtPort = typeof mgmtAddress === 'object' && mgmtAddress ? mgmtAddress.port : 0;

    const wsPort = BASE_PORT + 700;
    service = new ChatService(store, onEvent, onDone, onError, {
      channelPort: wsPort,
      managementBaseUrl: `http://127.0.0.1:${mgmtPort}`,
      managementToken: 'test-token',
    });

    wss = new WebSocketServer({ port: wsPort });
    wss.on('connection', (ws) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw));
        // Send one event with seq=1, then drop the socket WITHOUT
        // a 'done' frame — simulates a mid-stream network drop.
        ws.send(
          JSON.stringify({
            type: 'event',
            id: msg.id,
            seq: 1,
            event: { type: 'text_delta', text: 'hello' },
          }),
        );
        setTimeout(() => ws.terminate(), 20);
      });
    });
    await new Promise<void>((r) => wss?.on('listening', r));

    const conv = await createLocal(service, 'agent-1');
    await sendLocal(service, conv.id, 'hi');

    // Wait for the WS drop + reconciliation to complete.
    await vi.waitFor(() => {
      expect(onDone).toHaveBeenCalledWith(conv.id);
    });

    // The management replay endpoint was called once with the
    // last-seen seq (1).
    expect(replayCalls).toBe(1);
    expect(replaySinceSeqSeen).toBe(1);

    // onEvent was called for ALL 3 events — 1 live + 2 replayed.
    expect(onEvent).toHaveBeenCalledTimes(3);
    expect(onEvent).toHaveBeenNthCalledWith(1, conv.id, { type: 'text_delta', text: 'hello' });
    expect(onEvent).toHaveBeenNthCalledWith(2, conv.id, { type: 'text_delta', text: ' world' });
    expect(onEvent).toHaveBeenNthCalledWith(
      3,
      conv.id,
      expect.objectContaining({ type: 'response', content: 'hello world' }),
    );
    // onError was NOT called — the replay delivered a clean 'done'
    // terminal so the stream is considered complete.
    expect(onError).not.toHaveBeenCalled();

    // Assistant message persisted with all 3 events.
    const msgs = await localMessages(service, conv.id);
    expect(msgs).toHaveLength(2);
    expect(msgs[1].role).toBe('assistant');
    const assistantContent = msgs[1].content as { events?: unknown[] };
    expect(assistantContent.events).toHaveLength(3);

    await new Promise<void>((r) => managementServer.close(() => r()));
  });

  it('falls back to connection-dropped error when replay returns no terminal', async () => {
    // Management endpoint returns zero new entries — the stream is
    // apparently still running on the gateway side. ChatService
    // should call onError with a connection-dropped message and
    // persist whatever partial state we have.
    const managementServer: Server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ entries: [] }));
    });
    await new Promise<void>((r) => managementServer.listen(0, '127.0.0.1', r));
    const mgmtAddress = managementServer.address();
    const mgmtPort = typeof mgmtAddress === 'object' && mgmtAddress ? mgmtAddress.port : 0;

    const wsPort = BASE_PORT + 800;
    service = new ChatService(store, onEvent, onDone, onError, {
      channelPort: wsPort,
      managementBaseUrl: `http://127.0.0.1:${mgmtPort}`,
      managementToken: 'test-token',
    });

    wss = new WebSocketServer({ port: wsPort });
    wss.on('connection', (ws) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw));
        ws.send(
          JSON.stringify({
            type: 'event',
            id: msg.id,
            seq: 1,
            event: { type: 'text_delta', text: 'half' },
          }),
        );
        setTimeout(() => ws.terminate(), 20);
      });
    });
    await new Promise<void>((r) => wss?.on('listening', r));

    const conv = await createLocal(service, 'agent-1');
    await sendLocal(service, conv.id, 'hi');

    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalledWith(conv.id, 'WebSocket connection dropped');
    });

    expect(onDone).not.toHaveBeenCalled();
    // The one live event we did see is still persisted.
    const msgs = await localMessages(service, conv.id);
    expect(msgs).toHaveLength(2);
    const assistantContent = msgs[1].content as { events?: unknown[] };
    expect(assistantContent.events).toHaveLength(1);

    await new Promise<void>((r) => managementServer.close(() => r()));
  });

  // ------------------------------------------------------------------
  // Startup reconciliation (reconcileAllConversations)
  // ------------------------------------------------------------------

  it('reconcileAllConversations replays missing events for a conversation with a trailing user message', async () => {
    const managementServer: Server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      const sinceSeq = Number(url.searchParams.get('sinceSeq') ?? '0');
      // Return 2 events + done for anything the client asks for.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          entries: [
            {
              seq: sinceSeq + 1,
              msgId: 'mid',
              agentId: 'agent-1',
              conversationId: 'c',
              timestamp: '2026-04-14T00:00:00Z',
              payload: { type: 'event', event: { type: 'text_delta', text: 'recovered' } },
            },
            {
              seq: sinceSeq + 2,
              msgId: 'mid',
              agentId: 'agent-1',
              conversationId: 'c',
              timestamp: '2026-04-14T00:00:00Z',
              payload: {
                type: 'event',
                event: {
                  type: 'response',
                  content: 'recovered',
                  usage: { inputTokens: 1, outputTokens: 1 },
                },
              },
            },
            {
              seq: sinceSeq + 3,
              msgId: 'mid',
              agentId: 'agent-1',
              conversationId: 'c',
              timestamp: '2026-04-14T00:00:00Z',
              payload: { type: 'done' },
            },
          ],
        }),
      );
    });
    await new Promise<void>((r) => managementServer.listen(0, '127.0.0.1', r));
    const mgmtAddress = managementServer.address();
    const mgmtPort = typeof mgmtAddress === 'object' && mgmtAddress ? mgmtAddress.port : 0;

    service = new ChatService(store, onEvent, onDone, onError, {
      channelPort: 0, // unused — no WS in this test
      managementBaseUrl: `http://127.0.0.1:${mgmtPort}`,
      managementToken: 'test-token',
    });

    // Set up a conversation that has a user message but NO
    // assistant reply — the classic "crashed mid-chat" state.
    const conv = await createLocal(service, 'agent-1');
    await store.appendMessage(conv.id, {
      id: 'u1',
      role: 'user',
      content: { type: 'user', text: 'hello' },
      timestamp: '2026-04-14T00:00:00Z',
    });

    await service.reconcileAllConversations();

    // Both replayed events fired through onEvent; done fired.
    expect(onEvent).toHaveBeenCalledTimes(2);
    expect(onEvent).toHaveBeenNthCalledWith(1, conv.id, { type: 'text_delta', text: 'recovered' });
    expect(onDone).toHaveBeenCalledWith(conv.id);

    // A new assistant message was appended carrying `lastSeq`.
    const msgs = await store.getMessages(conv.id);
    expect(msgs).toHaveLength(2);
    expect(msgs[1].role).toBe('assistant');
    const assistantContent = msgs[1].content as {
      events?: unknown[];
      lastSeq?: number;
    };
    expect(assistantContent.events).toHaveLength(2);
    expect(assistantContent.lastSeq).toBe(3);

    await new Promise<void>((r) => managementServer.close(() => r()));
  });

  it('reconcileAllConversations skips a fully-complete conversation', async () => {
    let replayCalls = 0;
    const managementServer: Server = createServer((_req, res) => {
      replayCalls++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ entries: [] }));
    });
    await new Promise<void>((r) => managementServer.listen(0, '127.0.0.1', r));
    const mgmtAddress = managementServer.address();
    const mgmtPort = typeof mgmtAddress === 'object' && mgmtAddress ? mgmtAddress.port : 0;

    service = new ChatService(store, onEvent, onDone, onError, {
      channelPort: 0,
      managementBaseUrl: `http://127.0.0.1:${mgmtPort}`,
      managementToken: 'test-token',
    });

    const conv = await createLocal(service, 'agent-1');
    await store.appendMessage(conv.id, {
      id: 'u1',
      role: 'user',
      content: { type: 'user', text: 'hi' },
      timestamp: '2026-04-14T00:00:00Z',
    });
    // Last message is a complete assistant reply — has a
    // `response` event. Reconciliation should skip it.
    await store.appendMessage(conv.id, {
      id: 'a1',
      role: 'assistant',
      content: {
        type: 'assistant',
        events: [
          { type: 'text_delta', text: 'hi' },
          {
            type: 'response',
            content: 'hi',
            usage: { inputTokens: 1, outputTokens: 1 },
          },
        ],
        lastSeq: 5,
      },
      timestamp: '2026-04-14T00:00:00Z',
    });

    await service.reconcileAllConversations();

    expect(replayCalls).toBe(0);
    expect(onEvent).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();

    await new Promise<void>((r) => managementServer.close(() => r()));
  });

  it('reconcileAllConversations resumes from the highest lastSeq in an incomplete conversation', async () => {
    let replaySinceSeqSeen: number | undefined;
    const managementServer: Server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      replaySinceSeqSeen = Number(url.searchParams.get('sinceSeq') ?? '0');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ entries: [] }));
    });
    await new Promise<void>((r) => managementServer.listen(0, '127.0.0.1', r));
    const mgmtAddress = managementServer.address();
    const mgmtPort = typeof mgmtAddress === 'object' && mgmtAddress ? mgmtAddress.port : 0;

    service = new ChatService(store, onEvent, onDone, onError, {
      channelPort: 0,
      managementBaseUrl: `http://127.0.0.1:${mgmtPort}`,
      managementToken: 'test-token',
    });

    const conv = await createLocal(service, 'agent-1');
    await store.appendMessage(conv.id, {
      id: 'u1',
      role: 'user',
      content: { type: 'user', text: 'hi' },
      timestamp: '2026-04-14T00:00:00Z',
    });
    // Incomplete assistant — no `response` event — but has a
    // `lastSeq` so reconciliation should ask the replay endpoint
    // for everything past that cursor.
    await store.appendMessage(conv.id, {
      id: 'a1',
      role: 'assistant',
      content: {
        type: 'assistant',
        events: [{ type: 'text_delta', text: 'partial' }],
        lastSeq: 7,
      },
      timestamp: '2026-04-14T00:00:00Z',
    });

    await service.reconcileAllConversations();

    expect(replaySinceSeqSeen).toBe(7);

    await new Promise<void>((r) => managementServer.close(() => r()));
  });

  it('reconcileAllConversations is a no-op when management endpoint is not configured', async () => {
    service = new ChatService(store, onEvent, onDone, onError, {
      channelPort: 0,
      // no managementBaseUrl / managementToken
    });
    const conv = await createLocal(service, 'agent-1');
    await store.appendMessage(conv.id, {
      id: 'u1',
      role: 'user',
      content: { type: 'user', text: 'hi' },
      timestamp: '2026-04-14T00:00:00Z',
    });

    await expect(service.reconcileAllConversations()).resolves.toBeUndefined();
    expect(onEvent).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('setGatewayConnection updates the connection', async () => {
    const port = BASE_PORT + 600;
    const noGwService = new ChatService(store, onEvent, onDone, onError);
    noGwService.setGatewayConnection({ channelPort: port });

    wss = new WebSocketServer({ port });
    wss.on('connection', (ws) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw));
        ws.send(JSON.stringify({ type: 'done', id: msg.id }));
      });
    });
    await new Promise<void>((r) => wss?.on('listening', r));

    const conv = await createLocal(noGwService, 'agent-1');
    await sendLocal(noGwService, conv.id, 'hello');
    await new Promise((r) => setTimeout(r, 100));

    expect(onDone).toHaveBeenCalledWith(conv.id);
  });
});

describe('ChatService gateway conversations', () => {
  let dataDir: string;
  let store: ConversationStore;
  let gateway: FixtureGatewayConversationRepository;
  let controller: ConversationController;
  let resumable: {
    send: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
    cancel: ReturnType<typeof vi.fn>;
    answer: ReturnType<typeof vi.fn>;
    closeAll: ReturnType<typeof vi.fn>;
  };
  let service: ChatService;

  beforeEach(async () => {
    dataDir = join(tmpdir(), `chat-service-gateway-${Date.now()}-${Math.random()}`);
    await mkdir(dataDir, { recursive: true });
    store = new ConversationStore(dataDir);
    gateway = await FixtureGatewayConversationRepository.load();
    controller = new ConversationController(
      new LegacyConversationRepository(store, (agentId) => agentId),
    );
    controller.configure({
      gatewayId: 'gateway-1',
      online: true,
      capabilities: ['conversation-sync-v1', 'chat-resume-v1'],
      repository: gateway,
    });
    resumable = {
      send: vi.fn(),
      subscribe: vi.fn().mockResolvedValue(undefined),
      cancel: vi.fn(),
      answer: vi.fn(),
      closeAll: vi.fn(),
    };
    service = new ChatService(
      store,
      vi.fn(),
      vi.fn(),
      vi.fn(),
      { channelPort: 9 },
      undefined,
      controller,
      resumable as unknown as ResumableChatTransport,
    );
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function gatewayView(): Promise<McConversationView> {
    return (await controller.list({ limit: 50 })).items.find(
      (item) => item.origin === 'gateway',
    ) as McConversationView;
  }

  it('returns durable acceptance and never appends capable messages to ConversationStore', async () => {
    const append = vi.spyOn(store, 'appendMessage');
    const accepted =
      await fixture<Extract<MobileWsServerFrame, { type: 'accepted' }>>('chat-accepted.json');
    resumable.send.mockResolvedValue(accepted);
    const conversation = await gatewayView();

    await expect(
      service.sendMessage(
        { id: conversation.id, origin: 'gateway' },
        accepted.id,
        'hello from Mission Control',
      ),
    ).resolves.toEqual({ protocol: 'v1', frame: accepted });
    expect(resumable.send).toHaveBeenCalledWith(
      conversation,
      accepted.id,
      'hello from Mission Control',
      undefined,
      // No location provider is wired in tests, so the trailing location
      // argument is undefined and the frame stays byte-identical to today's.
      undefined,
    );
    expect(append).not.toHaveBeenCalled();
    await expect(store.listAll()).resolves.toEqual([]);
  });

  it('preserves the current non-resumable local path for an older gateway', async () => {
    controller.configure({ gatewayId: 'old', online: true, capabilities: [], repository: null });
    const local = await service.createConversation('agent-1', 'request-local');
    await service.sendMessage({ id: local.id, origin: 'local' }, 'legacy-turn', 'hello');

    expect(resumable.send).not.toHaveBeenCalled();
    expect((await store.getMessages(local.id))[0]).toMatchObject({ role: 'user' });
  });

  it.each(['capable', 'unresolved'] as const)(
    'rejects a local-ref send while conversation authority is %s',
    async (mode) => {
      const local = await store.create('agent-local');
      if (mode === 'unresolved') {
        controller.configure({
          gatewayId: null,
          online: false,
          capabilities: null,
          repository: null,
        });
      }
      const append = vi.spyOn(store, 'appendMessage');

      await expect(
        service.sendMessage({ id: local.id, origin: 'local' }, 'stale-local-turn', 'do not send'),
      ).rejects.toBeInstanceOf(ConversationRepositoryOfflineError);

      expect(append).not.toHaveBeenCalled();
      expect(resumable.send).not.toHaveBeenCalled();
      await expect(store.getMessages(local.id)).resolves.toEqual([]);
    },
  );

  it('subscribes to a turn that is active on iOS from transcript throughSeq', async () => {
    const conversation = await gatewayView();
    const active = { ...conversation, status: 'running' as const, activeTurnId: 'ios-turn-1' };
    vi.spyOn(gateway, 'get').mockResolvedValue(active);
    vi.spyOn(gateway, 'messages').mockResolvedValue({
      items: [],
      nextCursor: null,
      throughSeq: 14,
    });

    await service.getMessages({ id: active.id, origin: 'gateway' });

    expect(resumable.subscribe).toHaveBeenCalledWith(active, 'ios-turn-1', 14);
  });

  it('rejects known-capable offline create, send, rename, and delete without local fallback', async () => {
    const conversation = await gatewayView();
    gateway.setOffline(true);
    controller.configure({
      gatewayId: 'gateway-1',
      online: false,
      capabilities: ['conversation-sync-v1'],
      repository: gateway,
    });
    const ref = { id: conversation.id, origin: 'gateway' as const };

    await expect(service.createConversation('agent-1', 'request-offline')).rejects.toBeInstanceOf(
      ConversationRepositoryOfflineError,
    );
    await expect(service.sendMessage(ref, 'turn-offline', 'hello')).rejects.toBeInstanceOf(
      ConversationRepositoryOfflineError,
    );
    await expect(
      service.renameConversation(ref, conversation.revision, 'Offline rename'),
    ).rejects.toBeInstanceOf(ConversationRepositoryOfflineError);
    await expect(service.deleteConversation(ref, conversation.revision)).rejects.toBeInstanceOf(
      ConversationRepositoryOfflineError,
    );
    await expect(store.listAll()).resolves.toEqual([]);
  });

  it('uses the canonical active turn for gateway cancel and answer', async () => {
    const conversation = await gatewayView();
    const active = { ...conversation, status: 'running' as const, activeTurnId: 'ios-turn-1' };
    vi.spyOn(gateway, 'get').mockResolvedValue(active);
    const ref = { id: active.id, origin: 'gateway' as const };

    await service.cancel(ref, 'ios-turn-1');
    await service.answerQuestion(ref, 'ios-turn-1', 'question-1', 'Yes');

    expect(resumable.cancel).toHaveBeenCalledWith(active.id, 'ios-turn-1');
    expect(resumable.answer).toHaveBeenCalledWith(active.id, 'ios-turn-1', 'question-1', 'Yes');
    await expect(service.cancel(ref, 'wrong-turn')).rejects.toThrow('active turn');
    await expect(service.answerQuestion(ref, 'wrong-turn', 'question-1', 'No')).rejects.toThrow(
      'active turn',
    );
  });

  it('returns canonical transcript message IDs without creating legacy shadows', async () => {
    const conversation = await gatewayView();

    const page = await service.getMessages({ id: conversation.id, origin: 'gateway' });

    expect(page.items.map((message) => message.id)).toEqual([
      '018f0f4a-5c42-7a8b-9c01-3234567890ab',
      '018f0f4a-5c42-7a8b-9c01-4234567890ab',
    ]);
    expect(page.throughSeq).toBe(5);
    await expect(store.getMessages(conversation.id)).resolves.toEqual([]);
  });

  it('closes the prior resumable transport when replacing it', () => {
    const replacement = { closeAll: vi.fn() } as unknown as ResumableChatTransport;

    service.setResumableTransport(replacement);

    expect(resumable.closeAll).toHaveBeenCalledOnce();
  });

  it('starts gateway title and task bookkeeping only after durable acceptance', async () => {
    const conversation = await gatewayView();
    const untitled = { ...conversation, title: 'New Conversation' };
    vi.spyOn(gateway, 'get').mockResolvedValue(untitled);
    let accept: ((frame: Extract<MobileWsServerFrame, { type: 'accepted' }>) => void) | undefined;
    resumable.send.mockReturnValue(
      new Promise((resolve) => {
        accept = resolve;
      }),
    );
    const fetchMock = vi.fn(async (url: string | URL) => {
      const path = String(url);
      if (path.includes('/conversation-title')) {
        return new Response(JSON.stringify({ title: 'Accepted title', project: null }), {
          status: 200,
        });
      }
      if (path.endsWith('/issues')) {
        return new Response(JSON.stringify({ id: 'issue-accepted', key: 'TASK-9' }), {
          status: 201,
        });
      }
      return new Response('{}', { status: 201 });
    });
    vi.stubGlobal('fetch', fetchMock);
    service.setGatewayConnection({
      channelPort: 9,
      managementBaseUrl: 'http://mgmt.test',
      managementToken: 'token',
    });

    const pending = service.sendMessage(
      { id: untitled.id, origin: 'gateway' },
      'turn-accepted',
      'hello',
    );
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();

    accept?.(
      await fixture<Extract<MobileWsServerFrame, { type: 'accepted' }>>('chat-accepted.json'),
    );
    await pending;
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
  });

  it('retries one revision conflict and preserves a concurrent manual title', async () => {
    const conversation = await gatewayView();
    const untitled = { ...conversation, title: 'New Conversation', revision: 2 };
    const manuallyRenamed = { ...untitled, title: 'Human title', revision: 3 };
    vi.spyOn(gateway, 'get')
      .mockResolvedValueOnce(untitled)
      .mockResolvedValueOnce(untitled)
      .mockResolvedValue(manuallyRenamed);
    const patch = vi
      .spyOn(gateway, 'patch')
      .mockRejectedValueOnce(
        new GatewayHttpError(409, 'patch conversation', '', {
          code: 'revision_conflict',
          error: 'Revision changed',
          retryable: true,
        }),
      )
      .mockResolvedValue({
        ...manuallyRenamed,
        owningIssueId: 'issue-retry',
        projectId: 'project-retry',
        revision: 4,
      });
    resumable.send.mockResolvedValue(
      await fixture<Extract<MobileWsServerFrame, { type: 'accepted' }>>('chat-accepted.json'),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const path = String(url);
        if (path.includes('/conversation-title')) {
          return new Response(
            JSON.stringify({ title: 'Generated title', project: { id: 'project-retry' } }),
            { status: 200 },
          );
        }
        if (path.endsWith('/issues')) {
          return new Response(JSON.stringify({ id: 'issue-retry', key: 'TASK-10' }), {
            status: 201,
          });
        }
        return new Response('{}', { status: 201 });
      }),
    );
    service.setGatewayConnection({
      channelPort: 9,
      managementBaseUrl: 'http://mgmt.test',
      managementToken: 'token',
    });

    await service.sendMessage({ id: untitled.id, origin: 'gateway' }, 'turn-revision', 'hello');

    await vi.waitFor(() => expect(patch).toHaveBeenCalledTimes(2));
    expect(patch.mock.calls[1]).toEqual([
      untitled.id,
      3,
      { owningIssueId: 'issue-retry', projectId: 'project-retry' },
    ]);
  });
});

describe('ChatService conversation v2', () => {
  let dataDir: string;
  let store: ConversationStore;
  let bootstrap: MobileV2ConversationBootstrap;
  let olderPage: MobileV2ConversationMessagePage;
  let accepted: Extract<MobileV2SequencedFrame, { type: 'accepted' }>;
  let controller: {
    bootstrap: ReturnType<typeof vi.fn>;
    messagesV2: ReturnType<typeof vi.fn>;
    messages: ReturnType<typeof vi.fn>;
    find: ReturnType<typeof vi.fn>;
  };
  let transport: ConversationChatTransport;
  let service: ChatService;
  let onEvent: ReturnType<typeof vi.fn>;
  let onDone: ReturnType<typeof vi.fn>;
  let onError: ReturnType<typeof vi.fn>;

  function mockTransport(): ConversationChatTransport {
    const value = new ConversationChatTransport({
      connection: { url: 'ws://chat.test' },
      channelId: 'mission-control',
      onFrame: vi.fn(),
      onConnectionError: vi.fn(),
      onCommandError: vi.fn(),
      socketFactory: vi.fn() as never,
    });
    vi.spyOn(value, 'open').mockResolvedValue(undefined);
    vi.spyOn(value, 'send').mockResolvedValue(accepted);
    vi.spyOn(value, 'enqueueInput').mockResolvedValue(undefined as never);
    vi.spyOn(value, 'editFollowUp').mockResolvedValue(undefined as never);
    vi.spyOn(value, 'removeFollowUp').mockResolvedValue(undefined as never);
    vi.spyOn(value, 'resumeFollowUps').mockResolvedValue(undefined as never);
    vi.spyOn(value, 'cancel').mockImplementation(() => {});
    vi.spyOn(value, 'answer').mockImplementation(() => {});
    vi.spyOn(value, 'closeConversation').mockImplementation(() => {});
    vi.spyOn(value, 'closeAll').mockImplementation(() => {});
    return value;
  }

  beforeEach(async () => {
    dataDir = join(tmpdir(), `chat-service-v2-${Date.now()}-${Math.random()}`);
    await mkdir(dataDir, { recursive: true });
    store = new ConversationStore(dataDir);
    bootstrap = await fixtureV2<MobileV2ConversationBootstrap>('conversation-bootstrap.json');
    olderPage = await fixtureV2<MobileV2ConversationMessagePage>('conversation-message-page.json');
    accepted =
      await fixtureV2<Extract<MobileV2SequencedFrame, { type: 'accepted' }>>('chat-accepted.json');
    controller = {
      bootstrap: vi.fn().mockResolvedValue(bootstrap),
      messagesV2: vi.fn().mockResolvedValue(olderPage),
      messages: vi.fn(),
      find: vi.fn().mockResolvedValue({
        ...bootstrap.conversation,
        origin: 'gateway',
        offline: false,
        readOnly: false,
      }),
    };
    onEvent = vi.fn();
    onDone = vi.fn();
    onError = vi.fn();
    service = new ChatService(
      store,
      onEvent,
      onDone,
      onError,
      undefined,
      undefined,
      controller as never,
    );
    transport = mockTransport();
    service.setGatewayChatTransport(transport);
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  const ref = {
    id: '00000000-0000-4000-8000-000000000001',
    origin: 'gateway' as const,
  };

  it('returns v2 bootstrap and subscribes only after the renderer supplies its cursor', async () => {
    await expect(service.getInitialState(ref)).resolves.toEqual({ protocol: 'v2', bootstrap });
    expect(transport.open).not.toHaveBeenCalled();

    await service.subscribeV2(ref, bootstrap.v2ThroughSeq);

    expect(transport.open).toHaveBeenCalledWith(
      expect.objectContaining({ id: ref.id }),
      bootstrap.v2ThroughSeq,
    );
  });

  it('returns older history through the negotiated v2 page shape', async () => {
    await expect(service.getOlderMessages(ref, 'older-cursor')).resolves.toEqual({
      protocol: 'v2',
      page: olderPage,
    });
    expect(controller.messagesV2).toHaveBeenCalledWith(ref, {
      limit: 100,
      before: 'older-cursor',
    });
    expect(controller.messages).not.toHaveBeenCalled();
  });

  it('forwards queue identities unchanged and protocol-tags accepted sends', async () => {
    const inputAccepted =
      await fixtureV2<Extract<MobileV2SequencedFrame, { type: 'input_accepted' }>>(
        'input-accepted.json',
      );
    vi.mocked(transport.enqueueInput).mockResolvedValue(inputAccepted);
    const request = {
      commandId: inputAccepted.id,
      inputId: inputAccepted.input.inputId,
      behavior: 'steer' as const,
      expectedActiveTurnId: bootstrap.conversation.activeTurnId ?? undefined,
      text: inputAccepted.input.text,
      images: [],
    };

    await expect(service.enqueueInput(ref, request)).resolves.toEqual(inputAccepted);
    await expect(service.sendMessage(ref, accepted.id, 'hello')).resolves.toEqual({
      protocol: 'v2',
      frame: accepted,
    });

    expect(transport.enqueueInput).toHaveBeenCalledWith(
      expect.objectContaining({ id: ref.id }),
      request,
    );
    expect(transport.send).toHaveBeenCalledWith(
      expect.objectContaining({ id: ref.id }),
      accepted.id,
      'hello',
      undefined,
      undefined,
    );
  });

  it('forwards edit, remove, and resume identities without starting title bookkeeping', async () => {
    const updated =
      await fixtureV2<Extract<MobileV2SequencedFrame, { type: 'input_updated' }>>(
        'input-updated.json',
      );
    const removed =
      await fixtureV2<Extract<MobileV2SequencedFrame, { type: 'input_removed' }>>(
        'input-removed.json',
      );
    const resumed =
      await fixtureV2<Extract<MobileV2SequencedFrame, { type: 'queue_resumed' }>>(
        'queue-resumed.json',
      );
    vi.mocked(transport.editFollowUp).mockResolvedValue(updated);
    vi.mocked(transport.removeFollowUp).mockResolvedValue(removed);
    vi.mocked(transport.resumeFollowUps).mockResolvedValue(resumed);
    const edit = {
      commandId: updated.id,
      inputId: updated.input.inputId,
      expectedRevision: 0,
      text: updated.input.text,
      images: [],
    };

    await expect(service.editFollowUp(ref, edit)).resolves.toEqual(updated);
    await expect(
      service.removeFollowUp(ref, removed.id, removed.input.inputId, 0),
    ).resolves.toEqual(removed);
    await expect(service.resumeFollowUps(ref, resumed.id ?? 'missing', 6)).resolves.toEqual(
      resumed,
    );

    expect(transport.editFollowUp).toHaveBeenCalledWith(
      expect.objectContaining({ id: ref.id }),
      edit,
    );
    expect(transport.removeFollowUp).toHaveBeenCalledWith(
      expect.objectContaining({ id: ref.id }),
      removed.id,
      removed.input.inputId,
      0,
    );
    expect(transport.resumeFollowUps).toHaveBeenCalledWith(
      expect.objectContaining({ id: ref.id }),
      resumed.id,
      6,
    );
  });

  it('keeps non-UUID legacy run correlations opaque', async () => {
    const issues = vi.fn();
    service.setV2CommandIssueListener(issues);
    controller.find.mockResolvedValue({
      ...bootstrap.conversation,
      activeTurnId: 'turn-01',
      origin: 'gateway',
      offline: false,
      readOnly: false,
    });
    await service.subscribeV2(ref, bootstrap.v2ThroughSeq);

    await service.answerQuestion(ref, 'turn-01', 'question-legacy', 'Yes', 'legacy-token');
    service.handleV2CommandError(
      transport,
      ref.id,
      new ConversationChatCommandError('turn-01', {
        code: 'conversation_busy',
        error: 'Already done',
        retryable: false,
      }),
    );

    expect(transport.answer).toHaveBeenCalledWith(ref.id, 'turn-01', 'question-legacy', 'Yes');
    expect(issues).toHaveBeenCalledWith(
      expect.objectContaining({
        commandId: 'turn-01',
        kind: 'answer',
        questionId: 'question-legacy',
        localDispatchToken: 'legacy-token',
      }),
    );
  });

  it('keeps cancel and answer dispatch identities collision-safe for one opaque run ID', async () => {
    const issues = vi.fn();
    service.setV2CommandIssueListener(issues);
    await service.subscribeV2(ref, bootstrap.v2ThroughSeq);
    const runId = bootstrap.conversation.activeTurnId as string;

    await service.cancel(ref, runId, 'cancel-token');
    await service.answerQuestion(ref, runId, 'question-1', 'Yes', 'answer-token');
    service.handleV2CommandError(
      transport,
      ref.id,
      new ConversationChatCommandError(runId, {
        code: 'conversation_busy',
        error: 'Already terminal',
        retryable: false,
      }),
    );

    expect(transport.cancel).toHaveBeenCalledWith(ref.id, runId);
    expect(transport.answer).toHaveBeenCalledWith(ref.id, runId, 'question-1', 'Yes');
    expect(issues).toHaveBeenCalledTimes(2);
    expect(issues.mock.calls.map(([issue]) => issue)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          commandId: runId,
          kind: 'cancel',
          localDispatchToken: 'cancel-token',
          ambiguousCorrelation: true,
        }),
        expect.objectContaining({
          commandId: runId,
          kind: 'answer',
          localDispatchToken: 'answer-token',
          questionId: 'question-1',
          ambiguousCorrelation: true,
        }),
      ]),
    );
    expect(onDone).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();

    service.handleV2CommandError(
      transport,
      ref.id,
      new ConversationChatCommandError(runId, {
        code: 'conversation_busy',
        error: 'Duplicate callback',
        retryable: false,
      }),
    );
    expect(issues).toHaveBeenCalledTimes(2);
  });

  it('suppresses unknown, unsubscribed, and replaced-transport command callbacks', async () => {
    const issues = vi.fn();
    service.setV2CommandIssueListener(issues);
    await service.subscribeV2(ref, bootstrap.v2ThroughSeq);
    const runId = bootstrap.conversation.activeTurnId as string;
    const error = new ConversationChatCommandError(runId, {
      code: 'conversation_busy',
      error: 'Rejected',
      retryable: false,
    });

    service.handleV2CommandError(transport, ref.id, error);
    await service.cancel(ref, runId, 'cancel-token');
    service.unsubscribeV2(ref);
    service.handleV2CommandError(transport, ref.id, error);

    const replacement = mockTransport();
    service.setGatewayChatTransport(replacement);
    await service.subscribeV2(ref, bootstrap.v2ThroughSeq);
    await service.cancel(ref, runId, 'replacement-token');
    service.handleV2CommandError(transport, ref.id, error);

    expect(issues).not.toHaveBeenCalled();
  });

  it('carries current command context across a same-run rebase and drops it after run promotion', async () => {
    const issues = vi.fn();
    service.setV2CommandIssueListener(issues);
    const runId = bootstrap.conversation.activeTurnId as string;
    await service.subscribeV2(ref, bootstrap.v2ThroughSeq);
    await service.cancel(ref, runId, 'same-run-token');

    await service.subscribeV2(ref, bootstrap.v2ThroughSeq);
    service.handleV2CommandError(
      transport,
      ref.id,
      new ConversationChatCommandError(runId, {
        code: 'conversation_busy',
        error: 'Same run rejection',
        retryable: false,
      }),
    );
    expect(issues).toHaveBeenCalledWith(
      expect.objectContaining({
        localDispatchToken: 'same-run-token',
        ambiguousCorrelation: false,
      }),
    );

    issues.mockClear();
    await service.cancel(ref, runId, 'old-run-token');
    controller.find.mockResolvedValue({
      ...bootstrap.conversation,
      activeTurnId: 'promoted-run',
      origin: 'gateway',
      offline: false,
      readOnly: false,
    });
    await service.subscribeV2(ref, bootstrap.v2ThroughSeq);
    service.handleV2CommandError(
      transport,
      ref.id,
      new ConversationChatCommandError(runId, {
        code: 'conversation_busy',
        error: 'Old run rejection',
        retryable: false,
      }),
    );
    expect(issues).not.toHaveBeenCalled();
  });

  it('does not open a stale subscription whose lookup outlives unsubscribe', async () => {
    const lookup = deferred<McConversationView>();
    controller.find.mockReturnValueOnce(lookup.promise);

    const pending = service.subscribeV2(ref, bootstrap.v2ThroughSeq);
    service.unsubscribeV2(ref);
    lookup.resolve({
      ...bootstrap.conversation,
      origin: 'gateway',
      offline: false,
      readOnly: false,
    });

    await expect(pending).resolves.toBeUndefined();
    expect(transport.open).not.toHaveBeenCalled();
    expect(transport.closeConversation).toHaveBeenCalledWith(ref.id);
  });

  it('does not dispatch a delayed cancel or answer through a replacement transport', async () => {
    const issues = vi.fn();
    service.setV2CommandIssueListener(issues);
    const cancelLookup = deferred<McConversationView>();
    const answerLookup = deferred<McConversationView>();
    controller.find
      .mockReturnValueOnce(cancelLookup.promise)
      .mockReturnValueOnce(answerLookup.promise);
    const runId = bootstrap.conversation.activeTurnId as string;

    const cancel = service.cancel(ref, runId, 'cancel-token');
    const answer = service.answerQuestion(ref, runId, 'question-1', 'Yes', 'answer-token');
    const replacement = mockTransport();
    service.setGatewayChatTransport(replacement);
    const current = {
      ...bootstrap.conversation,
      origin: 'gateway' as const,
      offline: false,
      readOnly: false,
    };
    cancelLookup.resolve(current);
    answerLookup.resolve(current);

    await expect(cancel).resolves.toBeUndefined();
    await expect(answer).resolves.toBeUndefined();
    expect(transport.cancel).not.toHaveBeenCalled();
    expect(transport.answer).not.toHaveBeenCalled();
    expect(replacement.cancel).not.toHaveBeenCalled();
    expect(replacement.answer).not.toHaveBeenCalled();
    expect(issues).not.toHaveBeenCalled();
  });

  it('closes an in-flight open on unsubscribe and permits a fresh later subscription', async () => {
    const opening = deferred<void>();
    vi.mocked(transport.open).mockReturnValueOnce(opening.promise);

    const first = service.subscribeV2(ref, bootstrap.v2ThroughSeq);
    await vi.waitFor(() => expect(transport.open).toHaveBeenCalledOnce());
    service.unsubscribeV2(ref);
    opening.resolve(undefined);
    await expect(first).resolves.toBeUndefined();

    await service.subscribeV2(ref, bootstrap.v2ThroughSeq);
    expect(transport.open).toHaveBeenCalledTimes(2);
  });

  it('rejects stale acknowledgement-returning sends with ConversationChatSupersededError', async () => {
    const lookup = deferred<McConversationView>();
    controller.find.mockReturnValueOnce(lookup.promise);
    const pending = service.sendMessage(ref, accepted.id, 'keep this draft');

    service.unsubscribeV2(ref);
    lookup.resolve({
      ...bootstrap.conversation,
      origin: 'gateway',
      offline: false,
      readOnly: false,
    });

    await expect(pending).rejects.toBeInstanceOf(ConversationChatSupersededError);
    expect(transport.send).not.toHaveBeenCalled();
  });

  it('rejects a queue acknowledgement that arrives after unsubscribe', async () => {
    const acknowledgement = deferred<Extract<MobileV2SequencedFrame, { type: 'input_accepted' }>>();
    vi.mocked(transport.enqueueInput).mockReturnValueOnce(acknowledgement.promise);
    const request = {
      commandId: '00000000-0000-4000-8000-000000000301',
      inputId: '00000000-0000-4000-8000-000000000302',
      behavior: 'followUp' as const,
      text: 'preserve this editor',
    };
    const pending = service.enqueueInput(ref, request);
    await vi.waitFor(() => expect(transport.enqueueInput).toHaveBeenCalledOnce());
    service.unsubscribeV2(ref);
    acknowledgement.resolve(
      await fixtureV2<Extract<MobileV2SequencedFrame, { type: 'input_accepted' }>>(
        'input-accepted.json',
      ),
    );

    await expect(pending).rejects.toBeInstanceOf(ConversationChatSupersededError);
  });

  it('translates a pending send close rejection after unsubscribe into superseded', async () => {
    const acknowledgement = deferred<Extract<MobileV2SequencedFrame, { type: 'accepted' }>>();
    vi.mocked(transport.send).mockReturnValueOnce(acknowledgement.promise);
    const pending = service.sendMessage(ref, accepted.id, 'preserve this composer');
    const rejection = expect(pending).rejects.toBeInstanceOf(ConversationChatSupersededError);
    await vi.waitFor(() => expect(transport.send).toHaveBeenCalledOnce());

    service.unsubscribeV2(ref);
    acknowledgement.reject(new Error('socket closed while send was pending'));

    await rejection;
  });

  it('translates a pending queue close rejection after transport replacement into superseded', async () => {
    const acknowledgement = deferred<Extract<MobileV2SequencedFrame, { type: 'input_accepted' }>>();
    vi.mocked(transport.enqueueInput).mockReturnValueOnce(acknowledgement.promise);
    const request = {
      commandId: '00000000-0000-4000-8000-000000000301',
      inputId: '00000000-0000-4000-8000-000000000302',
      behavior: 'followUp' as const,
      text: 'preserve this editor',
    };
    const pending = service.enqueueInput(ref, request);
    const rejection = expect(pending).rejects.toBeInstanceOf(ConversationChatSupersededError);
    await vi.waitFor(() => expect(transport.enqueueInput).toHaveBeenCalledOnce());

    const replacement = mockTransport();
    service.setGatewayChatTransport(replacement);
    acknowledgement.reject(new Error('socket closed while queue command was pending'));

    await rejection;
    expect(replacement.enqueueInput).not.toHaveBeenCalled();
  });

  it('preserves a genuine current-generation queue transport rejection', async () => {
    const currentFailure = new Error('current queue domain failure');
    vi.mocked(transport.editFollowUp).mockRejectedValueOnce(currentFailure);

    await expect(
      service.editFollowUp(ref, {
        commandId: '00000000-0000-4000-8000-000000000301',
        inputId: '00000000-0000-4000-8000-000000000302',
        expectedRevision: 2,
        text: 'keep this failure identity',
      }),
    ).rejects.toBe(currentFailure);
  });

  it('revalidates a delayed cancel after a same-run rebase and dispatches exactly once', async () => {
    await service.subscribeV2(ref, bootstrap.v2ThroughSeq);
    const delayedCommandLookup = deferred<McConversationView>();
    const rebaseLookup = deferred<McConversationView>();
    const current = {
      ...bootstrap.conversation,
      origin: 'gateway' as const,
      offline: false,
      readOnly: false,
    };
    controller.find
      .mockReturnValueOnce(delayedCommandLookup.promise)
      .mockReturnValueOnce(rebaseLookup.promise)
      .mockResolvedValue(current);
    const runId = bootstrap.conversation.activeTurnId as string;

    const cancel = service.cancel(ref, runId, 'rebased-cancel');
    const rebase = service.subscribeV2(ref, bootstrap.v2ThroughSeq);
    delayedCommandLookup.resolve(current);
    await Promise.resolve();
    expect(transport.cancel).not.toHaveBeenCalled();
    rebaseLookup.resolve(current);

    await rebase;
    await cancel;
    expect(transport.cancel).toHaveBeenCalledOnce();
    expect(transport.cancel).toHaveBeenCalledWith(ref.id, runId);
  });

  it('rejects a delayed answer when a rebase promotes a different active run', async () => {
    await service.subscribeV2(ref, bootstrap.v2ThroughSeq);
    const delayedCommandLookup = deferred<McConversationView>();
    const rebaseLookup = deferred<McConversationView>();
    const oldRun = bootstrap.conversation.activeTurnId as string;
    const promoted = {
      ...bootstrap.conversation,
      activeTurnId: 'promoted-run',
      origin: 'gateway' as const,
      offline: false,
      readOnly: false,
    };
    controller.find
      .mockReturnValueOnce(delayedCommandLookup.promise)
      .mockReturnValueOnce(rebaseLookup.promise)
      .mockResolvedValue(promoted);

    const answer = service.answerQuestion(ref, oldRun, 'question-1', 'Yes', 'promoted-answer');
    const rebase = service.subscribeV2(ref, bootstrap.v2ThroughSeq);
    delayedCommandLookup.resolve(promoted);
    rebaseLookup.resolve(promoted);

    await rebase;
    await expect(answer).rejects.toThrow('does not have active turn');
    expect(transport.answer).not.toHaveBeenCalled();
  });

  it('waits for a synchronously registered rebase barrier before dispatching a queue command', async () => {
    await service.subscribeV2(ref, bootstrap.v2ThroughSeq);
    vi.mocked(transport.open).mockClear();
    const rebaseLookup = deferred<McConversationView>();
    controller.find.mockReturnValueOnce(rebaseLookup.promise);
    const rebase = service.subscribeV2(ref, bootstrap.v2ThroughSeq);
    const enqueue = service.enqueueInput(ref, {
      commandId: '00000000-0000-4000-8000-000000000301',
      inputId: '00000000-0000-4000-8000-000000000302',
      behavior: 'followUp',
      text: 'after the rebase',
    });

    await Promise.resolve();
    expect(controller.find).toHaveBeenCalledTimes(2);
    expect(transport.enqueueInput).not.toHaveBeenCalled();

    rebaseLookup.resolve({
      ...bootstrap.conversation,
      origin: 'gateway',
      offline: false,
      readOnly: false,
    });
    await rebase;
    await enqueue;

    expect(transport.open).toHaveBeenCalledOnce();
    expect(transport.enqueueInput).toHaveBeenCalledOnce();
  });

  it('follows a newer same-run subscribe barrier after the enqueue waiter sees the prior barrier reject', async () => {
    const firstOpen = deferred<void>();
    const secondOpen = deferred<void>();
    const inputAccepted =
      await fixtureV2<Extract<MobileV2SequencedFrame, { type: 'input_accepted' }>>(
        'input-accepted.json',
      );
    vi.mocked(transport.open)
      .mockReturnValueOnce(firstOpen.promise)
      .mockReturnValueOnce(secondOpen.promise);
    vi.mocked(transport.enqueueInput).mockResolvedValue(inputAccepted);
    const request = {
      commandId: inputAccepted.id,
      inputId: inputAccepted.input.inputId,
      behavior: 'followUp' as const,
      expectedActiveTurnId: bootstrap.conversation.activeTurnId ?? undefined,
      text: 'keep these exact identities',
      images: [],
    };

    const firstSubscribe = service.subscribeV2(ref, 10);
    await vi.waitFor(() => expect(transport.open).toHaveBeenCalledTimes(1));
    const enqueue = service.enqueueInput(ref, request);
    const enqueueAssertion = expect(enqueue).resolves.toEqual(inputAccepted);
    const secondSubscribe = service.subscribeV2(ref, 11);
    await vi.waitFor(() => expect(transport.open).toHaveBeenCalledTimes(2));

    firstOpen.reject(new Error('prior subscribe was superseded'));
    secondOpen.resolve(undefined);

    await expect(firstSubscribe).resolves.toBeUndefined();
    await expect(secondSubscribe).resolves.toBeUndefined();
    await enqueueAssertion;
    expect(transport.enqueueInput).toHaveBeenCalledOnce();
    expect(transport.enqueueInput).toHaveBeenCalledWith(
      expect.objectContaining({ id: ref.id, activeTurnId: request.expectedActiveTurnId }),
      request,
    );
  });

  it('follows a newer same-run subscribe barrier before dispatching a waiting cancel once', async () => {
    const firstOpen = deferred<void>();
    const secondOpen = deferred<void>();
    vi.mocked(transport.open)
      .mockReturnValueOnce(firstOpen.promise)
      .mockReturnValueOnce(secondOpen.promise);
    const runId = bootstrap.conversation.activeTurnId as string;

    const firstSubscribe = service.subscribeV2(ref, 10);
    await vi.waitFor(() => expect(transport.open).toHaveBeenCalledTimes(1));
    const cancel = service.cancel(ref, runId, 'barrier-cancel-token');
    const cancelAssertion = expect(cancel).resolves.toBeUndefined();
    const secondSubscribe = service.subscribeV2(ref, 11);
    await vi.waitFor(() => expect(transport.open).toHaveBeenCalledTimes(2));

    firstOpen.reject(new Error('prior subscribe was superseded'));
    secondOpen.resolve(undefined);

    await expect(firstSubscribe).resolves.toBeUndefined();
    await expect(secondSubscribe).resolves.toBeUndefined();
    await cancelAssertion;
    expect(transport.cancel).toHaveBeenCalledOnce();
    expect(transport.cancel).toHaveBeenCalledWith(ref.id, runId);
  });

  it('does not expose a pending old-transport subscribe barrier to replacement commands', async () => {
    const oldOpen = deferred<void>();
    vi.mocked(transport.open).mockReturnValueOnce(oldOpen.promise);
    const oldSubscribe = service.subscribeV2(ref, 10);
    await vi.waitFor(() => expect(transport.open).toHaveBeenCalledOnce());

    const replacement = mockTransport();
    const inputAccepted =
      await fixtureV2<Extract<MobileV2SequencedFrame, { type: 'input_accepted' }>>(
        'input-accepted.json',
      );
    vi.mocked(replacement.enqueueInput).mockResolvedValue(inputAccepted);
    service.setGatewayChatTransport(replacement);
    const request = {
      commandId: inputAccepted.id,
      inputId: inputAccepted.input.inputId,
      behavior: 'followUp' as const,
      text: 'dispatch on replacement',
    };
    const enqueue = service.enqueueInput(ref, request);
    const enqueueAssertion = expect(enqueue).resolves.toEqual(inputAccepted);

    oldOpen.reject(new Error('old transport closed'));

    await expect(oldSubscribe).resolves.toBeUndefined();
    await enqueueAssertion;
    expect(replacement.enqueueInput).toHaveBeenCalledOnce();
    expect(replacement.enqueueInput).toHaveBeenCalledWith(
      expect.objectContaining({ id: ref.id }),
      request,
    );
  });

  it('makes ChatService the sole owner of transport replacement closure', () => {
    const replacement = mockTransport();

    service.setGatewayChatTransport(replacement);
    service.setGatewayChatTransport(replacement);
    service.setGatewayChatTransport(undefined);

    expect(transport.closeAll).toHaveBeenCalledOnce();
    expect(replacement.closeAll).toHaveBeenCalledOnce();
  });
});

describe('ChatService auto-title + auto-task', () => {
  let dataDir: string;
  let store: ConversationStore;
  let wss: WebSocketServer | undefined;
  let onRenamed: ReturnType<typeof vi.fn>;
  let service: ChatService;
  const port = BASE_PORT + 150;

  function makeTitledService(gc?: Partial<GatewayConnection>): ChatService {
    return new ChatService(
      store,
      vi.fn(),
      vi.fn(),
      vi.fn(),
      { channelPort: port, managementBaseUrl: 'http://mgmt.test', managementToken: 'tok', ...gc },
      onRenamed,
    );
  }

  /**
   * Fetch stub routing the three management calls the first-message hook
   * makes. Pass null for a step to make that call fail with a 500.
   */
  function stubManagement(opts: {
    title?: { title: string; project?: { id: string; key: string } | null } | null;
    issue?: { id: string; key: string } | null;
  }): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const path = String(url);
      if (path.includes('/conversation-title')) {
        if (!opts.title) return new Response('boom', { status: 500 });
        return new Response(JSON.stringify({ project: null, ...opts.title }), { status: 200 });
      }
      if (path.endsWith('/issues')) {
        if (!opts.issue) return new Response('boom', { status: 500 });
        return new Response(JSON.stringify(opts.issue), { status: 201 });
      }
      if (path.includes('/sessions')) {
        return new Response(JSON.stringify({}), { status: 201 });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  function callsTo(fetchMock: ReturnType<typeof vi.fn>, needle: string): unknown[][] {
    return fetchMock.mock.calls.filter((c) => String(c[0]).includes(needle));
  }

  /** Echo WS server so sendMessage's stream terminates cleanly. */
  async function startWs(): Promise<void> {
    wss = new WebSocketServer({ port });
    wss.on('connection', (ws) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw));
        ws.send(JSON.stringify({ type: 'done', id: msg.id }));
      });
    });
    await new Promise<void>((r) => wss?.on('listening', r));
  }

  async function settle(): Promise<void> {
    await service.drainBackgroundTasks();
  }

  beforeEach(async () => {
    dataDir = join(tmpdir(), `chat-title-test-${Date.now()}-${Math.random()}`);
    await mkdir(dataDir, { recursive: true });
    store = new ConversationStore(dataDir);
    onRenamed = vi.fn();
    service = makeTitledService();
    await startWs();
  });

  afterEach(async () => {
    await service.drainBackgroundTasks();
    vi.unstubAllGlobals();
    if (wss) {
      await new Promise<void>((r) => wss?.close(() => r()));
      wss = undefined;
    }
    // Straggler index writes can race the removal; retry.
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('titles the conversation, creates a linked task, and renames to "KEY — title"', async () => {
    const fetchMock = stubManagement({
      title: { title: 'Login bug triage', project: { id: 'p1', key: 'AUTH' } },
      issue: { id: 'i1', key: 'AUTH-7' },
    });

    const conv = await createLocal(service, 'agent-1');
    await sendLocal(service, conv.id, 'my login form crashes on submit');
    await vi.waitFor(async () => {
      expect((await store.get(conv.id))?.title).toBe('AUTH-7 — Login bug triage');
    });

    const [, titleInit] = callsTo(fetchMock, '/conversation-title')[0] as [string, RequestInit];
    expect(titleInit.method).toBe('POST');
    expect((titleInit.headers as Record<string, string>).authorization).toBe('Bearer tok');

    const [, issueInit] = callsTo(fetchMock, '/issues')[0] as [string, RequestInit];
    const issueBody = JSON.parse(String(issueInit.body));
    expect(issueBody.title).toBe('Login bug triage');
    expect(issueBody.project_id).toBe('p1');
    expect(issueBody.description).toContain('my login form crashes on submit');

    const [linkUrl, linkInit] = callsTo(fetchMock, '/sessions')[0] as [string, RequestInit];
    expect(linkUrl).toContain('/issues/i1/sessions');
    expect(JSON.parse(String(linkInit.body))).toEqual({
      session_id: conv.id,
      agent_id: 'agent-1',
    });

    expect(onRenamed).toHaveBeenCalledWith(localRef(conv.id), 'AUTH-7 — Login bug triage');
  });

  it('creates a standalone task when no project was inferred', async () => {
    const fetchMock = stubManagement({
      title: { title: 'Login bug triage', project: null },
      issue: { id: 'i2', key: 'TASK-3' },
    });

    const conv = await createLocal(service, 'agent-1');
    await sendLocal(service, conv.id, 'my login form crashes on submit');
    await vi.waitFor(async () => {
      expect((await store.get(conv.id))?.title).toBe('TASK-3 — Login bug triage');
    });

    const [, issueInit] = callsTo(fetchMock, '/issues')[0] as [string, RequestInit];
    expect(JSON.parse(String(issueInit.body)).project_id).toBeNull();
  });

  it('still creates the task with the placeholder title when titling fails', async () => {
    stubManagement({ title: null, issue: { id: 'i3', key: 'TASK-4' } });

    const conv = await createLocal(service, 'agent-1');
    await sendLocal(service, conv.id, 'hello there companion');
    await vi.waitFor(async () => {
      expect((await store.get(conv.id))?.title).toBe('TASK-4 — hello there companion');
    });
  });

  it('keeps the plain title when task creation fails', async () => {
    stubManagement({ title: { title: 'Login bug triage' }, issue: null });

    const conv = await createLocal(service, 'agent-1');
    await sendLocal(service, conv.id, 'my login form crashes on submit');
    await vi.waitFor(async () => {
      expect((await store.get(conv.id))?.title).toBe('Login bug triage');
    });
  });

  it('keeps the truncated fallback when every management call fails', async () => {
    stubManagement({ title: null, issue: null });

    const conv = await createLocal(service, 'agent-1');
    await sendLocal(service, conv.id, 'hello there companion');
    await settle();

    expect((await store.get(conv.id))?.title).toBe('hello there companion');
    expect(onRenamed).not.toHaveBeenCalled();
  });

  it('does not run the hook for later messages', async () => {
    const fetchMock = stubManagement({
      title: { title: 'T' },
      issue: { id: 'i5', key: 'TASK-5' },
    });

    const conv = await createLocal(service, 'agent-1');
    await sendLocal(service, conv.id, 'first message');
    await settle();
    await sendLocal(service, conv.id, 'second message');
    await settle();

    expect(callsTo(fetchMock, '/conversation-title')).toHaveLength(1);
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/issues'))).toHaveLength(1);
  });

  it('skips everything without a management connection', async () => {
    const fetchMock = stubManagement({ title: { title: 'T' }, issue: { id: 'x', key: 'K' } });
    service = makeTitledService({ managementBaseUrl: undefined, managementToken: undefined });

    const conv = await createLocal(service, 'agent-1');
    await sendLocal(service, conv.id, 'hello');
    await settle();

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
