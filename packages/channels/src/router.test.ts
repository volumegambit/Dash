import type { AgentClient } from '@dash/agent';
import { describe, expect, it, vi } from 'vitest';
import { MessageRouter } from './router.js';
import type { ChannelAdapter, InboundMessage, RouterConfig } from './types.js';

function makeAgent(): AgentClient {
  return {
    chat: vi.fn().mockImplementation(async function* () {
      yield { type: 'response', content: 'hi', usage: {} };
    }),
  } as unknown as AgentClient;
}

function makeAdapter(): ChannelAdapter & {
  trigger: (msg: Partial<InboundMessage>) => Promise<void>;
} {
  let handler: ((msg: InboundMessage) => Promise<void>) | null = null;
  return {
    name: 'test',
    start: vi.fn(),
    stop: vi.fn(),
    send: vi.fn(),
    onMessage: (h) => {
      handler = h;
    },
    async trigger(msg: Partial<InboundMessage>) {
      await handler!({
        channelId: 'test',
        conversationId: 'conv-1',
        senderId: 'user-1',
        senderName: 'Test User',
        text: 'hello',
        timestamp: new Date(),
        ...msg,
      });
    },
  };
}

describe('MessageRouter - routing rules', () => {
  it('routes to default rule when sender matches no other condition', async () => {
    const defaultAgent = makeAgent();
    const agents = new Map([['default', defaultAgent]]);
    const router = new MessageRouter(agents);
    const adapter = makeAdapter();

    const config: RouterConfig = {
      globalDenyList: [],
      rules: [
        { condition: { type: 'default' }, agentName: 'default', allowList: [], denyList: [] },
      ],
    };
    router.addAdapter(adapter, config);

    await adapter.trigger({ senderId: 'anyone' });
    expect(defaultAgent.chat).toHaveBeenCalledTimes(1);
  });

  it('routes sender-matched rule before default', async () => {
    const vipAgent = makeAgent();
    const defaultAgent = makeAgent();
    const agents = new Map([
      ['vip', vipAgent],
      ['default', defaultAgent],
    ]);
    const router = new MessageRouter(agents);
    const adapter = makeAdapter();

    const config: RouterConfig = {
      globalDenyList: [],
      rules: [
        {
          condition: { type: 'sender', ids: ['vip-user'] },
          agentName: 'vip',
          allowList: [],
          denyList: [],
        },
        { condition: { type: 'default' }, agentName: 'default', allowList: [], denyList: [] },
      ],
    };
    router.addAdapter(adapter, config);

    await adapter.trigger({ senderId: 'vip-user' });
    expect(vipAgent.chat).toHaveBeenCalledTimes(1);
    expect(defaultAgent.chat).not.toHaveBeenCalled();
  });

  it('blocks sender in globalDenyList', async () => {
    const agent = makeAgent();
    const agents = new Map([['default', agent]]);
    const router = new MessageRouter(agents);
    const adapter = makeAdapter();

    const config: RouterConfig = {
      globalDenyList: ['blocked-user'],
      rules: [
        { condition: { type: 'default' }, agentName: 'default', allowList: [], denyList: [] },
      ],
    };
    router.addAdapter(adapter, config);

    await adapter.trigger({ senderId: 'blocked-user' });
    expect(agent.chat).not.toHaveBeenCalled();
  });

  it('blocks sender in rule denyList', async () => {
    const agent = makeAgent();
    const agents = new Map([['default', agent]]);
    const router = new MessageRouter(agents);
    const adapter = makeAdapter();

    const config: RouterConfig = {
      globalDenyList: [],
      rules: [
        {
          condition: { type: 'default' },
          agentName: 'default',
          allowList: [],
          denyList: ['blocked-user'],
        },
      ],
    };
    router.addAdapter(adapter, config);

    await adapter.trigger({ senderId: 'blocked-user' });
    expect(agent.chat).not.toHaveBeenCalled();
  });

  it('rejects sender not in allowList when allowList is non-empty', async () => {
    const agent = makeAgent();
    const agents = new Map([['default', agent]]);
    const router = new MessageRouter(agents);
    const adapter = makeAdapter();

    const config: RouterConfig = {
      globalDenyList: [],
      rules: [
        {
          condition: { type: 'default' },
          agentName: 'default',
          allowList: ['allowed-user'],
          denyList: [],
        },
      ],
    };
    router.addAdapter(adapter, config);

    await adapter.trigger({ senderId: 'stranger' });
    expect(agent.chat).not.toHaveBeenCalled();

    await adapter.trigger({ senderId: 'allowed-user' });
    expect(agent.chat).toHaveBeenCalledTimes(1);
  });

  it('routes group message via group condition', async () => {
    const groupAgent = makeAgent();
    const defaultAgent = makeAgent();
    const agents = new Map([
      ['group', groupAgent],
      ['default', defaultAgent],
    ]);
    const router = new MessageRouter(agents);
    const adapter = makeAdapter();

    const config: RouterConfig = {
      globalDenyList: [],
      rules: [
        {
          condition: { type: 'group', ids: ['-100123456'] },
          agentName: 'group',
          allowList: [],
          denyList: [],
        },
        { condition: { type: 'default' }, agentName: 'default', allowList: [], denyList: [] },
      ],
    };
    router.addAdapter(adapter, config);

    await adapter.trigger({ conversationId: '-100123456', senderId: 'user-1' });
    expect(groupAgent.chat).toHaveBeenCalledTimes(1);
    expect(defaultAgent.chat).not.toHaveBeenCalled();
  });

  it('drops message silently when no rule matches', async () => {
    const agent = makeAgent();
    const agents = new Map([['vip', agent]]);
    const router = new MessageRouter(agents);
    const adapter = makeAdapter();

    const config: RouterConfig = {
      globalDenyList: [],
      rules: [
        {
          condition: { type: 'sender', ids: ['vip-only'] },
          agentName: 'vip',
          allowList: [],
          denyList: [],
        },
      ],
    };
    router.addAdapter(adapter, config);

    await expect(adapter.trigger({ senderId: 'stranger' })).resolves.not.toThrow();
    expect(agent.chat).not.toHaveBeenCalled();
  });

  it('backwards compat: addAdapter with string still works', async () => {
    const agent = makeAgent();
    const agents = new Map([['default', agent]]);
    const router = new MessageRouter(agents);
    const adapter = makeAdapter();

    router.addAdapter(adapter, 'default'); // old API
    await adapter.trigger({ senderId: 'user-1' });
    expect(agent.chat).toHaveBeenCalledTimes(1);
  });
});
