import { mkdir, rm } from 'node:fs/promises';
// @vitest-environment node
// Override jsdom (set in vitest.config.ts for this package). Needs Node for WebSocketServer and filesystem I/O.
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationStore } from '@dash/mc';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import type { GatewayConnection } from './chat-service.js';
import { ChatService } from './chat-service.js';

const BASE_PORT = 19700 + Math.floor(Math.random() * 200);

describe('ChatService', () => {
  let dataDir: string;
  let store: ConversationStore;
  let wss: WebSocketServer | undefined;
  let onEvent: ReturnType<typeof vi.fn>;
  let onDone: ReturnType<typeof vi.fn>;
  let onError: ReturnType<typeof vi.fn>;
  let service: ChatService;

  function makeService(port: number, token?: string): ChatService {
    const gw: GatewayConnection = { channelPort: port, chatToken: token };
    return new ChatService(store, onEvent, onDone, onError, gw);
  }

  beforeEach(async () => {
    dataDir = join(tmpdir(), `chat-service-test-${Date.now()}`);
    await mkdir(dataDir, { recursive: true });
    store = new ConversationStore(dataDir);
    onEvent = vi.fn();
    onDone = vi.fn();
    onError = vi.fn();
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
    const conv = await service.createConversation('agent-1');
    expect(conv.agentId).toBe('agent-1');
    const list = await service.listConversations();
    expect(list).toHaveLength(1);
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

    const conv = await service.createConversation('agent-1');
    await service.sendMessage(conv.id, 'hello');

    // Wait for async WS event processing
    await new Promise((r) => setTimeout(r, 100));

    expect(onEvent).toHaveBeenCalledWith(conv.id, { type: 'text_delta', text: 'Hi' });
    expect(onDone).toHaveBeenCalledWith(conv.id);

    // Messages should be persisted
    const msgs = await service.getMessages(conv.id);
    expect(msgs).toHaveLength(2); // user + assistant
    expect(msgs[0].role).toBe('user');
    expect(msgs[1].role).toBe('assistant');
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

    const conv = await service.createConversation('agent-1');
    await service.sendMessage(conv.id, 'hello');
    await new Promise((r) => setTimeout(r, 100));

    expect(onError).toHaveBeenCalledWith(conv.id, 'agent exploded');
  });

  it('throws if gateway connection is not configured', async () => {
    const noGwService = new ChatService(store, onEvent, onDone, onError);
    const conv = await noGwService.createConversation('agent-1');
    await expect(noGwService.sendMessage(conv.id, 'hello')).rejects.toThrow(
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

    const conv = await service.createConversation('agent-1');
    // Don't await — sendMessage sets up the WS and returns quickly for a hanging server
    service.sendMessage(conv.id, 'hello').catch(() => {});

    // Give time for WS to open and message to be sent
    await new Promise((r) => setTimeout(r, 50));

    service.cancel(conv.id);

    // Give time for WS close to propagate
    await new Promise((r) => setTimeout(r, 50));

    // After cancel, no more events should fire
    expect(onDone).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();

    void serverWs; // suppress unused variable warning
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

    const conv = await service.createConversation('agent-1');
    service.sendMessage(conv.id, 'hello').catch(() => {});

    // Wait for question event to arrive
    await vi.waitFor(() => {
      expect(onEvent).toHaveBeenCalledWith(
        conv.id,
        expect.objectContaining({ type: 'question', id: 'q-1' }),
      );
    });

    // Send answer
    service.answerQuestion(conv.id, 'q-1', 'A');

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

  it('answerQuestion throws if no active stream', () => {
    expect(() => service.answerQuestion('nonexistent', 'q-1', 'A')).toThrow('No active stream');
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
      replayCalls++;
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
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

    const conv = await service.createConversation('agent-1');
    await service.sendMessage(conv.id, 'hi');

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
    const msgs = await service.getMessages(conv.id);
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

    const conv = await service.createConversation('agent-1');
    await service.sendMessage(conv.id, 'hi');

    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalledWith(conv.id, 'WebSocket connection dropped');
    });

    expect(onDone).not.toHaveBeenCalled();
    // The one live event we did see is still persisted.
    const msgs = await service.getMessages(conv.id);
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
    const conv = await service.createConversation('agent-1');
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
    const msgs = await service.getMessages(conv.id);
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

    const conv = await service.createConversation('agent-1');
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

    const conv = await service.createConversation('agent-1');
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
    const conv = await service.createConversation('agent-1');
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

    const conv = await noGwService.createConversation('agent-1');
    await noGwService.sendMessage(conv.id, 'hello');
    await new Promise((r) => setTimeout(r, 100));

    expect(onDone).toHaveBeenCalledWith(conv.id);
  });
});
