import type { AgentClient, AgentEvent } from '@dash/agent';
import { MissionControlAdapter } from '@dash/channels';
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

function nextMessage(ws: WebSocket): Promise<Record<string, unknown>> {
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

  it('creates gateway with routing-rules channel without throwing', () => {
    const config: GatewayConfig = {
      agents: {
        default: { url: 'ws://localhost:9101', token: 'agent-token' },
      },
      channels: {
        telegram: {
          adapter: 'telegram',
          token: 'bot-token',
          globalDenyList: [],
          routing: [
            { condition: { type: 'default' }, agentName: 'default', allowList: [], denyList: [] },
          ],
        },
      },
    };
    expect(() => createGateway(config)).not.toThrow();
  });
});

describe('Gateway end-to-end with MC adapter', () => {
  // Ports 20100–20499: isolated from packages/channels tests (19200–19999)
  const basePort = 20100 + Math.floor(Math.random() * 400);
  let gateway: { start(): Promise<void>; stop(): Promise<void> } | undefined;

  afterEach(async () => {
    if (gateway) {
      await gateway.stop();
      gateway = undefined;
    }
  });

  it('returns error frame for unknown agent name', async () => {
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
    const responsePromise = nextMessage(ws);

    ws.send(
      JSON.stringify({
        type: 'message',
        conversationId: 'conv-1',
        agentName: 'nonexistent',
        text: 'hello',
      }),
    );

    const response = await responsePromise;
    expect(response).toMatchObject({
      type: 'error',
      conversationId: 'conv-1',
      error: expect.stringContaining('nonexistent'),
    });

    ws.close();
  });
});

// The following tests exercise MissionControlAdapter directly with mock AgentClient
// implementations. createGateway always constructs RemoteAgentClient from config, so
// controllable agent injection requires bypassing createGateway. The adapter is the
// component createGateway hands the agents map to, so these tests validate the same
// code path at one level below the gateway integration boundary.
//
// Happy-path streaming is also covered by packages/channels/src/adapters/mission-control.test.ts;
// these gateway-level tests confirm the error paths and ensure the adapter receives the
// correct agents map when wired through real (non-mock) gateway construction.
describe('MC adapter agent routing (direct)', () => {
  // Ports 20500–20899: isolated from packages/channels tests (19200–19999) and
  // the createGateway describe above (20100–20499)
  const basePort = 20500 + Math.floor(Math.random() * 400);
  let adapter: MissionControlAdapter | undefined;

  afterEach(async () => {
    if (adapter) {
      await adapter.stop();
      adapter = undefined;
    }
  });

  it('sends error frame when agent.chat() throws', async () => {
    // Deterministic mock: always throws so we can assert exactly type === 'error'
    const throwingAgent: AgentClient = {
      // biome-ignore lint/correctness/useYield: throw-only generator for testing
      async *chat(): AsyncGenerator<AgentEvent> {
        throw new Error('agent exploded');
      },
    };

    adapter = new MissionControlAdapter(basePort, new Map([['default', throwingAgent]]));
    await adapter.start();

    const ws = await connectWs(basePort);
    const responsePromise = nextMessage(ws);

    ws.send(
      JSON.stringify({
        type: 'message',
        conversationId: 'conv-2',
        agentName: 'default',
        text: 'hello',
      }),
    );

    const response = await responsePromise;
    expect(response).toMatchObject({
      type: 'error',
      conversationId: 'conv-2',
      error: expect.stringContaining('agent exploded'),
    });

    ws.close();
  });

  it('relays event and done frames for a successful agent response', async () => {
    const events: AgentEvent[] = [
      { type: 'text_delta', text: 'Hello' },
      {
        type: 'response',
        content: 'Hello',
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    ];
    const successAgent: AgentClient = {
      async *chat(): AsyncGenerator<AgentEvent> {
        for (const e of events) yield e;
      },
    };

    adapter = new MissionControlAdapter(basePort + 1, new Map([['default', successAgent]]));
    await adapter.start();

    const ws = await connectWs(basePort + 1);
    ws.send(
      JSON.stringify({
        type: 'message',
        conversationId: 'conv-3',
        agentName: 'default',
        text: 'hi',
      }),
    );

    const frame1 = await nextMessage(ws);
    expect(frame1).toMatchObject({ type: 'event', conversationId: 'conv-3' });

    // Drain remaining event frames until 'done'
    let last = frame1;
    while (last.type !== 'done') {
      last = await nextMessage(ws);
    }
    expect(last).toEqual({ type: 'done', conversationId: 'conv-3' });

    ws.close();
  });
});
