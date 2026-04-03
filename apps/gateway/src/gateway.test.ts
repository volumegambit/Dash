import type { AgentClient } from '@dash/agent';
import type { ChannelAdapter, InboundMessage } from '@dash/channels';
import { describe, expect, it, vi } from 'vitest';
import { createDynamicGateway } from './gateway.js';

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
