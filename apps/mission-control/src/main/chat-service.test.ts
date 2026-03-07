// @vitest-environment node
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRegistry, ConversationStore } from '@dash/mc';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { ChatService } from './chat-service.js';

const BASE_PORT = 19700 + Math.floor(Math.random() * 200);

function makeDeployment(chatPort: number, chatToken?: string) {
  return {
    id: 'dep-1',
    name: 'test',
    target: 'local' as const,
    status: 'running' as const,
    config: { target: 'local' as const, agents: {}, channels: {} },
    createdAt: new Date().toISOString(),
    chatPort,
    chatToken,
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

  beforeEach(async () => {
    dataDir = join(tmpdir(), `chat-service-test-${Date.now()}`);
    await mkdir(dataDir, { recursive: true });
    store = new ConversationStore(dataDir);
    registry = new AgentRegistry(dataDir);
    onEvent = vi.fn();
    onDone = vi.fn();
    onError = vi.fn();
    service = new ChatService(registry, store, onEvent, onDone, onError);
  });

  afterEach(async () => {
    if (wss) {
      await new Promise<void>((r) => wss?.close(() => r()));
      wss = undefined;
    }
    await rm(dataDir, { recursive: true, force: true });
  });

  it('creates and lists conversations', async () => {
    await registry.add(makeDeployment(BASE_PORT));
    const conv = await service.createConversation('dep-1', 'myagent');
    expect(conv.agentName).toBe('myagent');
    const list = await service.listConversations('dep-1');
    expect(list).toHaveLength(1);
  });

  it('sends user message then streams events and done', async () => {
    await registry.add(makeDeployment(BASE_PORT + 100));

    wss = new WebSocketServer({ port: BASE_PORT + 100 });
    wss.on('connection', (ws) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw));
        ws.send(
          JSON.stringify({
            type: 'event',
            conversationId: msg.conversationId,
            event: { type: 'text_delta', text: 'Hi' },
          }),
        );
        ws.send(JSON.stringify({ type: 'done', conversationId: msg.conversationId }));
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
    await registry.add(makeDeployment(BASE_PORT + 200));

    wss = new WebSocketServer({ port: BASE_PORT + 200 });
    wss.on('connection', (ws) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw));
        ws.send(
          JSON.stringify({
            type: 'error',
            conversationId: msg.conversationId,
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

  it('throws if deployment chatPort is missing', async () => {
    await registry.add({ ...makeDeployment(BASE_PORT + 300), chatPort: undefined });
    const conv = await service.createConversation('dep-1', 'myagent');
    await expect(service.sendMessage(conv.id, 'hello')).rejects.toThrow('not running');
  });

  it('cancel closes the active WebSocket', async () => {
    await registry.add(makeDeployment(BASE_PORT + 400));

    let serverWs: import('ws').WebSocket | undefined;
    wss = new WebSocketServer({ port: BASE_PORT + 400 });
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
});
