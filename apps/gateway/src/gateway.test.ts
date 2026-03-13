import type { AgentClient, AgentEvent } from '@dash/agent';
import { MissionControlAdapter } from '@dash/channels';
import type { ChannelAdapter, InboundMessage } from '@dash/channels';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GatewayConfig } from './config.js';
import { createDynamicGateway, createGateway } from './gateway.js';

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

// ── createDynamicGateway tests ──

function makeFakeAgent(): AgentClient {
  return {
    chat: vi.fn().mockImplementation(async function* () {
      yield { type: 'response', content: 'hello' };
    }),
  } as unknown as AgentClient;
}

function makeFakeAdapter(name: string): ChannelAdapter & {
  trigger: (msg: InboundMessage) => Promise<void>;
} {
  let handler: ((msg: InboundMessage) => Promise<void>) | undefined;
  return {
    name,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue(undefined),
    onMessage: (h) => {
      handler = h;
    },
    trigger: async (msg) => {
      await handler?.(msg);
    },
  };
}

describe('createDynamicGateway', () => {
  it('starts with no agents or channels', () => {
    const gw = createDynamicGateway();
    expect(gw.agentCount()).toBe(0);
    expect(gw.channelCount()).toBe(0);
  });

  it('registers an agent', () => {
    const gw = createDynamicGateway();
    gw.registerAgent('dep1', 'default', makeFakeAgent());
    expect(gw.agentCount()).toBe(1);
  });

  it('deregisters all agents for a deployment', async () => {
    const gw = createDynamicGateway();
    gw.registerAgent('dep1', 'default', makeFakeAgent());
    gw.registerAgent('dep1', 'specialist', makeFakeAgent());
    await gw.deregisterDeployment('dep1');
    expect(gw.agentCount()).toBe(0);
  });

  it('registers a channel and starts its adapter', async () => {
    const gw = createDynamicGateway();
    gw.registerAgent('dep1', 'default', makeFakeAgent());

    const adapter = makeFakeAdapter('telegram');
    await gw.registerChannel('dep1', 'tg1', adapter, {
      globalDenyList: [],
      routing: [
        { condition: { type: 'default' }, agentName: 'default', allowList: [], denyList: [] },
      ],
    });

    expect(adapter.start).toHaveBeenCalled();
    expect(gw.channelCount()).toBe(1);
  });

  it('routes messages from a registered channel to the correct agent', async () => {
    const gw = createDynamicGateway();
    const agent = makeFakeAgent();
    gw.registerAgent('dep1', 'default', agent);

    const adapter = makeFakeAdapter('telegram');
    await gw.registerChannel('dep1', 'tg1', adapter, {
      globalDenyList: [],
      routing: [
        { condition: { type: 'default' }, agentName: 'default', allowList: [], denyList: [] },
      ],
    });

    await adapter.trigger({
      channelId: 'tg1',
      conversationId: 'conv1',
      senderId: 'user1',
      senderName: 'User',
      text: 'hi',
      timestamp: new Date(),
    });

    expect(agent.chat).toHaveBeenCalledWith('tg1', 'conv1', 'hi');
  });

  it('deregistering deployment stops adapter when no rules remain', async () => {
    const gw = createDynamicGateway();
    gw.registerAgent('dep1', 'default', makeFakeAgent());

    const adapter = makeFakeAdapter('telegram');
    await gw.registerChannel('dep1', 'tg1', adapter, {
      globalDenyList: [],
      routing: [
        { condition: { type: 'default' }, agentName: 'default', allowList: [], denyList: [] },
      ],
    });

    await gw.deregisterDeployment('dep1');

    expect(adapter.stop).toHaveBeenCalled();
    expect(gw.channelCount()).toBe(0);
  });

  it('deregistering one deployment leaves channels used by another', async () => {
    const gw = createDynamicGateway();

    gw.registerAgent('dep1', 'default', makeFakeAgent());
    gw.registerAgent('dep2', 'default', makeFakeAgent());

    const adapter = makeFakeAdapter('telegram');
    await gw.registerChannel('dep1', 'tg1', adapter, {
      globalDenyList: [],
      routing: [
        {
          condition: { type: 'sender', ids: ['user1'] },
          agentName: 'default',
          allowList: [],
          denyList: [],
        },
      ],
    });
    await gw.registerChannel('dep2', 'tg1', adapter, {
      globalDenyList: [],
      routing: [
        {
          condition: { type: 'sender', ids: ['user2'] },
          agentName: 'default',
          allowList: [],
          denyList: [],
        },
      ],
    });

    await gw.deregisterDeployment('dep1');

    // Adapter still running — dep2 still has rules
    expect(adapter.stop).not.toHaveBeenCalled();
    expect(gw.channelCount()).toBe(1);
  });

  it('respects globalDenyList', async () => {
    const gw = createDynamicGateway();
    const agent = makeFakeAgent();
    gw.registerAgent('dep1', 'default', agent);

    const adapter = makeFakeAdapter('telegram');
    await gw.registerChannel('dep1', 'tg1', adapter, {
      globalDenyList: ['blocked-user'],
      routing: [
        { condition: { type: 'default' }, agentName: 'default', allowList: [], denyList: [] },
      ],
    });

    await adapter.trigger({
      channelId: 'tg1',
      conversationId: 'conv1',
      senderId: 'blocked-user',
      senderName: 'Blocked',
      text: 'hi',
      timestamp: new Date(),
    });

    expect(agent.chat).not.toHaveBeenCalled();
  });

  it('drops message when sender not in non-empty allowList', async () => {
    const gw = createDynamicGateway();
    const agent = makeFakeAgent();
    gw.registerAgent('dep1', 'default', agent);

    const adapter = makeFakeAdapter('telegram');
    await gw.registerChannel('dep1', 'tg1', adapter, {
      globalDenyList: [],
      routing: [
        {
          condition: { type: 'default' },
          agentName: 'default',
          allowList: ['allowed-user'],
          denyList: [],
        },
      ],
    });

    await adapter.trigger({
      channelId: 'tg1',
      conversationId: 'conv1',
      senderId: 'not-allowed',
      senderName: 'Stranger',
      text: 'hi',
      timestamp: new Date(),
    });

    expect(agent.chat).not.toHaveBeenCalled();
  });

  it('drops message when sender is in rule denyList', async () => {
    const gw = createDynamicGateway();
    const agent = makeFakeAgent();
    gw.registerAgent('dep1', 'default', agent);

    const adapter = makeFakeAdapter('telegram');
    await gw.registerChannel('dep1', 'tg1', adapter, {
      globalDenyList: [],
      routing: [
        {
          condition: { type: 'default' },
          agentName: 'default',
          allowList: [],
          denyList: ['denied-user'],
        },
      ],
    });

    await adapter.trigger({
      channelId: 'tg1',
      conversationId: 'conv1',
      senderId: 'denied-user',
      senderName: 'Denied',
      text: 'hi',
      timestamp: new Date(),
    });

    expect(agent.chat).not.toHaveBeenCalled();
  });

  it('globalDenyList from one deployment does not block messages to another deployment', async () => {
    const gw = createDynamicGateway();
    const agentA = makeFakeAgent();
    const agentB = makeFakeAgent();
    gw.registerAgent('dep1', 'default', agentA);
    gw.registerAgent('dep2', 'default', agentB);

    const adapter = makeFakeAdapter('telegram');
    // dep1 blocks 'userX' globally
    await gw.registerChannel('dep1', 'tg1', adapter, {
      globalDenyList: ['userX'],
      routing: [
        {
          condition: { type: 'sender', ids: ['userX'] },
          agentName: 'default',
          allowList: [],
          denyList: [],
        },
      ],
    });
    // dep2 does not block 'userX'
    await gw.registerChannel('dep2', 'tg1', adapter, {
      globalDenyList: [],
      routing: [
        {
          condition: { type: 'sender', ids: ['userX'] },
          agentName: 'default',
          allowList: [],
          denyList: [],
        },
      ],
    });

    await adapter.trigger({
      channelId: 'tg1',
      conversationId: 'conv1',
      senderId: 'userX',
      senderName: 'User',
      text: 'hi',
      timestamp: new Date(),
    });

    // dep1's agent blocked, dep2's agent should receive (first unblocked match wins)
    expect(agentA.chat).not.toHaveBeenCalled();
    expect(agentB.chat).toHaveBeenCalledWith('tg1', 'conv1', 'hi');
  });

  it('routes to first matching rule only (first-match-wins)', async () => {
    const gw = createDynamicGateway();
    const agentA = makeFakeAgent();
    const agentB = makeFakeAgent();
    gw.registerAgent('dep1', 'agentA', agentA);
    gw.registerAgent('dep1', 'agentB', agentB);

    const adapter = makeFakeAdapter('telegram');
    await gw.registerChannel('dep1', 'tg1', adapter, {
      globalDenyList: [],
      routing: [
        // First rule: matches sender user1
        {
          condition: { type: 'sender', ids: ['user1'] },
          agentName: 'agentA',
          allowList: [],
          denyList: [],
        },
        // Second rule: default (matches everything)
        {
          condition: { type: 'default' },
          agentName: 'agentB',
          allowList: [],
          denyList: [],
        },
      ],
    });

    await adapter.trigger({
      channelId: 'tg1',
      conversationId: 'conv1',
      senderId: 'user1',
      senderName: 'User',
      text: 'hi',
      timestamp: new Date(),
    });

    // Only agentA should be called (first match)
    expect(agentA.chat).toHaveBeenCalledWith('tg1', 'conv1', 'hi');
    expect(agentB.chat).not.toHaveBeenCalled();
  });
});
