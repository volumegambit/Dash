import type { Server } from 'node:http';
import type { AgentClient, AgentEvent } from '@dash/agent';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startChatServer } from './chat-server.js';
import { RemoteAgentClient } from './ws-client.js';

const TOKEN = 'test-token';

function createMockAgent(events: AgentEvent[]): AgentClient {
  return {
    async *chat() {
      for (const event of events) {
        yield event;
      }
    },
  };
}

describe('RemoteAgentClient', () => {
  let server: Server;
  let close: () => Promise<void>;
  let port: number;

  const mockEvents: AgentEvent[] = [
    { type: 'text_delta', text: 'Hello' },
    { type: 'response', content: 'Hello', usage: { inputTokens: 10, outputTokens: 5 } },
  ];

  beforeEach(async () => {
    const agents = new Map<string, AgentClient>();
    agents.set('default', createMockAgent(mockEvents));

    const result = startChatServer({
      port: 0,
      token: TOKEN,
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

  it('streams AgentEvent objects from the chat server', async () => {
    const client = new RemoteAgentClient(`ws://localhost:${port}/ws`, TOKEN, 'default');
    const events: AgentEvent[] = [];

    for await (const event of client.chat('channel', 'conv', 'Hello')) {
      events.push(event);
    }

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: 'text_delta', text: 'Hello' });
    expect(events[1]).toEqual({
      type: 'response',
      content: 'Hello',
      usage: { inputTokens: 10, outputTokens: 5 },
    });
  });

  it('yields error for wrong token', async () => {
    const client = new RemoteAgentClient(`ws://localhost:${port}/ws`, 'wrong-token', 'default');
    const events: AgentEvent[] = [];

    for await (const event of client.chat('channel', 'conv', 'Hello')) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('error');
  });

  it('yields error for unknown agent', async () => {
    const client = new RemoteAgentClient(`ws://localhost:${port}/ws`, TOKEN, 'nonexistent');
    const events: AgentEvent[] = [];

    for await (const event of client.chat('channel', 'conv', 'Hello')) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('error');
    if (events[0].type === 'error') {
      expect(events[0].error.message).toContain('nonexistent');
    }
  });
});
