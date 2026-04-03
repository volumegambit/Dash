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
    gw.registerAgent('agent1', makeFakeAgent());
    expect(gw.agentCount()).toBe(1);
  });

  it('deregisters an agent', async () => {
    const gw = createDynamicGateway();
    gw.registerAgent('agent1', makeFakeAgent());
    gw.registerAgent('agent2', makeFakeAgent());
    await gw.deregisterAgent('agent1');
    expect(gw.agentCount()).toBe(1);
  });

  it('registers a channel and starts its adapter', async () => {
    const gw = createDynamicGateway();
    gw.registerAgent('agent1', makeFakeAgent());

    const adapter = makeFakeAdapter('telegram');
    await gw.registerChannel('tg1', adapter, {
      globalDenyList: [],
      routing: [
        { condition: { type: 'default' }, agentId: 'agent1', allowList: [], denyList: [] },
      ],
    });

    expect(adapter.start).toHaveBeenCalled();
    expect(gw.channelCount()).toBe(1);
  });

  it('routes messages from a registered channel to the correct agent', async () => {
    const gw = createDynamicGateway();
    const agent = makeFakeAgent();
    gw.registerAgent('agent1', agent);

    const adapter = makeFakeAdapter('telegram');
    await gw.registerChannel('tg1', adapter, {
      globalDenyList: [],
      routing: [
        { condition: { type: 'default' }, agentId: 'agent1', allowList: [], denyList: [] },
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

    expect(agent.chat).toHaveBeenCalledWith('tg1', 'tg1:conv1', 'hi');
  });

  it('deregisterAgent stops adapter when no rules remain', async () => {
    const gw = createDynamicGateway();
    gw.registerAgent('agent1', makeFakeAgent());

    const adapter = makeFakeAdapter('telegram');
    await gw.registerChannel('tg1', adapter, {
      globalDenyList: [],
      routing: [
        { condition: { type: 'default' }, agentId: 'agent1', allowList: [], denyList: [] },
      ],
    });

    const removed = await gw.deregisterAgent('agent1');

    expect(adapter.stop).toHaveBeenCalled();
    expect(gw.channelCount()).toBe(0);
    expect(removed).toEqual(['tg1']);
  });

  it('deregisterAgent leaves channels that still have rules for other agents', async () => {
    const gw = createDynamicGateway();

    gw.registerAgent('agent1', makeFakeAgent());
    gw.registerAgent('agent2', makeFakeAgent());

    const adapter = makeFakeAdapter('telegram');
    await gw.registerChannel('tg1', adapter, {
      globalDenyList: [],
      routing: [
        {
          condition: { type: 'sender', ids: ['user1'] },
          agentId: 'agent1',
          allowList: [],
          denyList: [],
        },
        {
          condition: { type: 'sender', ids: ['user2'] },
          agentId: 'agent2',
          allowList: [],
          denyList: [],
        },
      ],
    });

    const removed = await gw.deregisterAgent('agent1');

    // Adapter still running — agent2 still has rules
    expect(adapter.stop).not.toHaveBeenCalled();
    expect(gw.channelCount()).toBe(1);
    expect(removed).toEqual([]);
  });

  it('respects globalDenyList', async () => {
    const gw = createDynamicGateway();
    const agent = makeFakeAgent();
    gw.registerAgent('agent1', agent);

    const adapter = makeFakeAdapter('telegram');
    await gw.registerChannel('tg1', adapter, {
      globalDenyList: ['blocked-user'],
      routing: [
        { condition: { type: 'default' }, agentId: 'agent1', allowList: [], denyList: [] },
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
    gw.registerAgent('agent1', agent);

    const adapter = makeFakeAdapter('telegram');
    await gw.registerChannel('tg1', adapter, {
      globalDenyList: [],
      routing: [
        {
          condition: { type: 'default' },
          agentId: 'agent1',
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
    gw.registerAgent('agent1', agent);

    const adapter = makeFakeAdapter('telegram');
    await gw.registerChannel('tg1', adapter, {
      globalDenyList: [],
      routing: [
        {
          condition: { type: 'default' },
          agentId: 'agent1',
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

  it('routes to first matching rule only (first-match-wins)', async () => {
    const gw = createDynamicGateway();
    const agentA = makeFakeAgent();
    const agentB = makeFakeAgent();
    gw.registerAgent('agentA', agentA);
    gw.registerAgent('agentB', agentB);

    const adapter = makeFakeAdapter('telegram');
    await gw.registerChannel('tg1', adapter, {
      globalDenyList: [],
      routing: [
        // First rule: matches sender user1
        {
          condition: { type: 'sender', ids: ['user1'] },
          agentId: 'agentA',
          allowList: [],
          denyList: [],
        },
        // Second rule: default (matches everything)
        {
          condition: { type: 'default' },
          agentId: 'agentB',
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
    expect(agentA.chat).toHaveBeenCalledWith('tg1', 'tg1:conv1', 'hi');
    expect(agentB.chat).not.toHaveBeenCalled();
  });

  it('prefixes conversationId with channel name', async () => {
    const gw = createDynamicGateway();
    const agent = makeFakeAgent();
    gw.registerAgent('agent1', agent);

    const adapter = makeFakeAdapter('telegram');
    await gw.registerChannel('my-channel', adapter, {
      globalDenyList: [],
      routing: [
        { condition: { type: 'default' }, agentId: 'agent1', allowList: [], denyList: [] },
      ],
    });

    await adapter.trigger({
      channelId: 'my-channel',
      conversationId: '12345',
      senderId: 'user1',
      senderName: 'User',
      text: 'hello',
      timestamp: new Date(),
    });

    expect(agent.chat).toHaveBeenCalledWith('my-channel', 'my-channel:12345', 'hello');
  });

  it('sends response with original unprefixed conversationId', async () => {
    const gw = createDynamicGateway();
    const agent = makeFakeAgent();
    gw.registerAgent('agent1', agent);

    const adapter = makeFakeAdapter('telegram');
    await gw.registerChannel('tg1', adapter, {
      globalDenyList: [],
      routing: [
        { condition: { type: 'default' }, agentId: 'agent1', allowList: [], denyList: [] },
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

    // adapter.send should receive the original unprefixed conversationId
    expect(adapter.send).toHaveBeenCalledWith('conv1', { text: 'hello' });
  });

  it('deregisterAgent removes rules and stops empty channels', async () => {
    const gw = createDynamicGateway();
    gw.registerAgent('agent1', makeFakeAgent());
    gw.registerAgent('agent2', makeFakeAgent());

    const adapter1 = makeFakeAdapter('telegram');
    const adapter2 = makeFakeAdapter('whatsapp');

    // Channel with only agent1 rules — should be removed
    await gw.registerChannel('ch1', adapter1, {
      globalDenyList: [],
      routing: [
        { condition: { type: 'default' }, agentId: 'agent1', allowList: [], denyList: [] },
      ],
    });

    // Channel with rules for both agents — should survive
    await gw.registerChannel('ch2', adapter2, {
      globalDenyList: [],
      routing: [
        {
          condition: { type: 'sender', ids: ['u1'] },
          agentId: 'agent1',
          allowList: [],
          denyList: [],
        },
        {
          condition: { type: 'default' },
          agentId: 'agent2',
          allowList: [],
          denyList: [],
        },
      ],
    });

    const removed = await gw.deregisterAgent('agent1');

    expect(removed).toEqual(['ch1']);
    expect(adapter1.stop).toHaveBeenCalled();
    expect(adapter2.stop).not.toHaveBeenCalled();
    expect(gw.channelCount()).toBe(1);
    expect(gw.agentCount()).toBe(1);
  });
});
