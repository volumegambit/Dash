// @vitest-environment node
// Override jsdom (set in vitest.config.ts for this package). Needs Node for WebSocketServer and filesystem I/O.
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRegistry, ConversationStore } from '@dash/mc';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import type { GatewayConnection } from './chat-service.js';
import { ChatService } from './chat-service.js';

const BASE_PORT = 19700 + Math.floor(Math.random() * 200);

function makeDeployment() {
  return {
    id: 'dep-1',
    name: 'test',
    target: 'local' as const,
    status: 'running' as const,
    config: { target: 'local' as const, agents: {}, channels: {} },
    createdAt: new Date().toISOString(),
  };
}

describe('ChatService', () => {
  let dataDir: string;
  let store: ConversationStore;
  let registry: AgentRegistry;
  let wss: WebSocketServer | undefined;
  let onEvent: ReturnType<typeof vi.fn>;
  let onDone: ReturnType<typeof vi.fn>;
  let onError: ReturnType<typeof vi.fn>;
  let service: ChatService;

  function makeService(port: number, token?: string): ChatService {
    const gw: GatewayConnection = { channelPort: port, chatToken: token };
    return new ChatService(registry, store, onEvent, onDone, onError, gw);
  }

  beforeEach(async () => {
    dataDir = join(tmpdir(), `chat-service-test-${Date.now()}`);
    await mkdir(dataDir, { recursive: true });
    store = new ConversationStore(dataDir);
    registry = new AgentRegistry(dataDir);
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
    await registry.add(makeDeployment());
    const conv = await service.createConversation('dep-1', 'myagent');
    expect(conv.agentName).toBe('myagent');
    const list = await service.listConversations('dep-1');
    expect(list).toHaveLength(1);
  });

  it('sends user message then streams events and done', async () => {
    const port = BASE_PORT + 100;
    service = makeService(port);
    await registry.add(makeDeployment());

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

    const conv = await service.createConversation('dep-1', 'myagent');
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
    await registry.add(makeDeployment());

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

    const conv = await service.createConversation('dep-1', 'myagent');
    await service.sendMessage(conv.id, 'hello');
    await new Promise((r) => setTimeout(r, 100));

    expect(onError).toHaveBeenCalledWith(conv.id, 'agent exploded');
  });

  it('throws if deployment is not running', async () => {
    await registry.add({ ...makeDeployment(), status: 'stopped' as const });
    const conv = await service.createConversation('dep-1', 'myagent');
    await expect(service.sendMessage(conv.id, 'hello')).rejects.toThrow('not running');
  });

  it('throws if gateway connection is not configured', async () => {
    const noGwService = new ChatService(registry, store, onEvent, onDone, onError);
    await registry.add(makeDeployment());
    const conv = await noGwService.createConversation('dep-1', 'myagent');
    await expect(noGwService.sendMessage(conv.id, 'hello')).rejects.toThrow(
      'Gateway connection not configured',
    );
  });

  it('cancel closes the active WebSocket', async () => {
    const port = BASE_PORT + 400;
    service = makeService(port);
    await registry.add(makeDeployment());

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

    const conv = await service.createConversation('dep-1', 'myagent');
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
    await registry.add(makeDeployment());

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

    const conv = await service.createConversation('dep-1', 'myagent');
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

  it('setGatewayConnection updates the connection', async () => {
    const port = BASE_PORT + 600;
    const noGwService = new ChatService(registry, store, onEvent, onDone, onError);
    noGwService.setGatewayConnection({ channelPort: port });
    await registry.add(makeDeployment());

    wss = new WebSocketServer({ port });
    wss.on('connection', (ws) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw));
        ws.send(JSON.stringify({ type: 'done', id: msg.id }));
      });
    });
    await new Promise<void>((r) => wss?.on('listening', r));

    const conv = await noGwService.createConversation('dep-1', 'myagent');
    await noGwService.sendMessage(conv.id, 'hello');
    await new Promise((r) => setTimeout(r, 100));

    expect(onDone).toHaveBeenCalledWith(conv.id);
  });
});
