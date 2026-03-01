import type { AgentClient, AgentEvent } from '@dash/agent';
import { MessageRouter, MissionControlAdapter } from '@dash/channels';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GatewayConfig } from './config.js';
import { createGateway } from './gateway.js';

function connectWs(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.addEventListener('open', () => resolve(ws));
    ws.addEventListener('error', reject);
  });
}

function waitForMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    ws.addEventListener(
      'message',
      (event) => {
        resolve(JSON.parse(String(event.data)));
      },
      { once: true },
    );
  });
}

describe('createGateway', () => {
  it('throws on unknown adapter type', () => {
    const config: GatewayConfig = {
      channels: {
        bad: { adapter: 'unknown' as 'telegram', agent: 'default' },
      },
      agents: {
        default: { url: 'ws://localhost:9101/ws', token: 'token' },
      },
    };

    expect(() => createGateway(config)).toThrow('Unknown adapter type');
  });

  it('throws when telegram channel has no token', () => {
    const config: GatewayConfig = {
      channels: {
        tg: { adapter: 'telegram', agent: 'default' },
      },
      agents: {
        default: { url: 'ws://localhost:9101/ws', token: 'token' },
      },
    };

    expect(() => createGateway(config)).toThrow('requires a "token" field');
  });
});

describe('Gateway end-to-end with MC adapter', () => {
  const port = 19300 + Math.floor(Math.random() * 1000);
  let stopFn: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (stopFn) {
      await stopFn();
      stopFn = undefined;
    }
  });

  it('routes messages through MC adapter to mock agent', async () => {
    // Create a mock agent that returns a fixed response
    const mockAgent: AgentClient = {
      async *chat(_channelId, _conversationId, text): AsyncGenerator<AgentEvent> {
        yield { type: 'text_delta', text: `Echo: ${text}` };
        yield {
          type: 'response',
          content: `Echo: ${text}`,
          usage: { inputTokens: 5, outputTokens: 5 },
        };
      },
    };

    // Wire up manually (same as createGateway but with mock agent)
    const agents = new Map<string, AgentClient>();
    agents.set('default', mockAgent);
    const router = new MessageRouter(agents);
    const adapter = new MissionControlAdapter(port);
    router.addAdapter(adapter, 'default');
    await router.startAll();
    stopFn = () => router.stopAll();

    // Connect as MC client
    const ws = await connectWs(port);
    const responsePromise = waitForMessage(ws);

    ws.send(JSON.stringify({ type: 'message', conversationId: 'conv-1', text: 'hello' }));

    const response = await responsePromise;
    expect(response).toEqual({
      type: 'response',
      conversationId: 'conv-1',
      text: 'Echo: hello',
    });

    ws.close();
  });
});
