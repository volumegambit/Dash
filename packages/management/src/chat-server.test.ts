import type { Server } from 'node:http';
import type { AgentClient, AgentEvent } from '@dash/agent';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startChatServer } from './chat-server.js';
import type { WsClientMessage, WsServerMessage } from './types.js';

const CHAT_TOKEN = 'test-chat-token';
const MGMT_TOKEN = 'test-mgmt-token';

function createMockAgent(events: AgentEvent[]): AgentClient {
  return {
    async *chat() {
      for (const event of events) {
        yield event;
      }
    },
  };
}

describe('Chat Server', () => {
  let server: Server;
  let close: () => Promise<void>;
  let port: number;

  const mockEvents: AgentEvent[] = [
    { type: 'text_delta', text: 'Hello' },
    { type: 'text_delta', text: ' world' },
    { type: 'response', content: 'Hello world', usage: { inputTokens: 10, outputTokens: 5 } },
  ];

  beforeEach(async () => {
    const agents = new Map<string, AgentClient>();
    agents.set('default', createMockAgent(mockEvents));

    const result = startChatServer({
      port: 0,
      token: CHAT_TOKEN,
      agents,
    });
    server = result.server;
    close = result.close;

    await new Promise<void>((resolve) => {
      if (server.listening) {
        resolve();
      } else {
        server.once('listening', resolve);
      }
    });
    const addr = server.address();
    port = typeof addr === 'object' && addr ? addr.port : 0;
  });

  afterEach(async () => {
    await close();
  });

  function wsUrl(token?: string): string {
    const t = token ?? CHAT_TOKEN;
    return `ws://localhost:${port}/ws?token=${encodeURIComponent(t)}`;
  }

  function collectMessages(ws: WebSocket): Promise<WsServerMessage[]> {
    const messages: WsServerMessage[] = [];
    return new Promise((resolve, reject) => {
      ws.addEventListener('message', (event) => {
        const msg = JSON.parse(String(event.data)) as WsServerMessage;
        messages.push(msg);
        if (msg.type === 'done' || msg.type === 'error') {
          resolve(messages);
        }
      });
      ws.addEventListener('error', () => reject(new Error('WebSocket error')));
      setTimeout(() => resolve(messages), 5000);
    });
  }

  it('streams agent events for a valid message', async () => {
    const ws = new WebSocket(wsUrl());
    await new Promise<void>((resolve) => ws.addEventListener('open', () => resolve()));

    const collecting = collectMessages(ws);

    const msg: WsClientMessage = {
      type: 'message',
      id: 'req-1',
      agent: 'default',
      channelId: 'test-channel',
      conversationId: 'conv-1',
      text: 'Hi there',
    };
    ws.send(JSON.stringify(msg));

    const messages = await collecting;
    ws.close();

    // Should have 3 events + 1 done
    expect(messages).toHaveLength(4);
    expect(messages[0]).toEqual({ type: 'event', id: 'req-1', event: mockEvents[0] });
    expect(messages[1]).toEqual({ type: 'event', id: 'req-1', event: mockEvents[1] });
    expect(messages[2]).toEqual({ type: 'event', id: 'req-1', event: mockEvents[2] });
    expect(messages[3]).toEqual({ type: 'done', id: 'req-1' });
  });

  it('rejects connection without token', async () => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    const code = await new Promise<number>((resolve) => {
      ws.addEventListener('close', (event) => resolve(event.code));
    });
    expect(code).toBe(4001);
  });

  it('rejects connection with wrong token', async () => {
    const ws = new WebSocket(wsUrl('wrong-token'));
    const code = await new Promise<number>((resolve) => {
      ws.addEventListener('close', (event) => resolve(event.code));
    });
    expect(code).toBe(4001);
  });

  it('returns error for unknown agent', async () => {
    const ws = new WebSocket(wsUrl());
    await new Promise<void>((resolve) => ws.addEventListener('open', () => resolve()));

    const collecting = collectMessages(ws);

    const msg: WsClientMessage = {
      type: 'message',
      id: 'req-2',
      agent: 'nonexistent',
      channelId: 'test-channel',
      conversationId: 'conv-1',
      text: 'Hi',
    };
    ws.send(JSON.stringify(msg));

    const messages = await collecting;
    ws.close();

    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe('error');
    expect((messages[0] as { error: string }).error).toContain('nonexistent');
  });

  it('handles cancel message', async () => {
    const ws = new WebSocket(wsUrl());
    await new Promise<void>((resolve) => ws.addEventListener('open', () => resolve()));

    const collecting = collectMessages(ws);

    const msg: WsClientMessage = { type: 'cancel', id: 'req-3' };
    ws.send(JSON.stringify(msg));

    const messages = await collecting;
    ws.close();

    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({ type: 'done', id: 'req-3' });
  });

  it('returns error for invalid JSON', async () => {
    const ws = new WebSocket(wsUrl());
    await new Promise<void>((resolve) => ws.addEventListener('open', () => resolve()));

    const msgPromise = new Promise<WsServerMessage>((resolve) => {
      ws.addEventListener('message', (event) => {
        resolve(JSON.parse(String(event.data)) as WsServerMessage);
      });
    });

    ws.send('not valid json{{{');

    const response = await msgPromise;
    ws.close();

    expect(response.type).toBe('error');
    expect((response as { error: string }).error).toBe('Invalid JSON');
  });

  it('rejects management token on chat port', async () => {
    const ws = new WebSocket(wsUrl(MGMT_TOKEN));
    const code = await new Promise<number>((resolve) => {
      ws.addEventListener('close', (event) => resolve(event.code));
    });
    expect(code).toBe(4001);
  });

  it('returns error for message with missing required fields', async () => {
    const ws = new WebSocket(wsUrl());
    await new Promise<void>((resolve) => ws.addEventListener('open', () => resolve()));

    const collecting = collectMessages(ws);

    // Valid JSON but missing agent, channelId, conversationId, text
    ws.send(JSON.stringify({ type: 'message', id: 'req-bad' }));

    const messages = await collecting;
    ws.close();

    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe('error');
    expect(messages[0].id).toBe('req-bad');
    expect((messages[0] as { error: string }).error).toContain('missing required fields');
  });

  it('returns error for message with unknown type', async () => {
    const ws = new WebSocket(wsUrl());
    await new Promise<void>((resolve) => ws.addEventListener('open', () => resolve()));

    const collecting = collectMessages(ws);

    ws.send(JSON.stringify({ type: 'unknown', id: 'req-unk' }));

    const messages = await collecting;
    ws.close();

    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe('error');
    expect((messages[0] as { error: string }).error).toContain('missing required fields');
  });
});
