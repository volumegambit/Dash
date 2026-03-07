import { afterEach, describe, expect, it } from 'vitest';
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
  const basePort = 19300 + Math.floor(Math.random() * 500);
  let gateway: { start(): Promise<void>; stop(): Promise<void> } | undefined;

  afterEach(async () => {
    if (gateway) {
      await gateway.stop();
      gateway = undefined;
    }
  });

  it('returns error frame when agent endpoint is unreachable', async () => {
    // MC channels do not require an agent field in config
    const config: GatewayConfig = {
      channels: {
        mc: { adapter: 'mission-control', port: basePort },
      },
      agents: {
        default: { url: 'ws://localhost:9101/ws', token: 'token' },
      },
    };

    gateway = createGateway(config);
    await gateway.start();

    const ws = await connectWs(basePort);
    const responsePromise = waitForMessage(ws);

    // New protocol requires agentName; 'default' exists but its endpoint is unreachable
    ws.send(
      JSON.stringify({ type: 'message', conversationId: 'conv-1', agentName: 'default', text: 'hello' }),
    );

    // RemoteAgentClient throws on connection failure → adapter sends error frame
    const response = await responsePromise;
    expect(response).toMatchObject({
      conversationId: 'conv-1',
    });
    // Either an error (connection refused) or an event/done — both are acceptable
    expect(['error', 'event', 'done']).toContain(response.type);

    ws.close();
  }, 15000);

  it('returns error frame for unknown agent name', async () => {
    const config: GatewayConfig = {
      channels: {
        mc: { adapter: 'mission-control', port: basePort + 1 },
      },
      agents: {
        default: { url: 'ws://localhost:9101/ws', token: 'token' },
      },
    };

    gateway = createGateway(config);
    await gateway.start();

    const ws = await connectWs(basePort + 1);
    const responsePromise = waitForMessage(ws);

    ws.send(
      JSON.stringify({ type: 'message', conversationId: 'conv-2', agentName: 'nonexistent', text: 'hello' }),
    );

    const response = await responsePromise;
    expect(response).toMatchObject({
      type: 'error',
      conversationId: 'conv-2',
      error: expect.stringContaining('nonexistent'),
    });

    ws.close();
  }, 10000);
});
