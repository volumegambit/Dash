import type { AgentClient } from '@dash/agent';
import type { ChannelAdapter, InboundMessage } from '@dash/channels';
import { SLASH_HELP, formatSkillList } from '@dash/channels';
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
      routing: [{ condition: { type: 'default' }, agentId: 'agent1', allowList: [], denyList: [] }],
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
      routing: [{ condition: { type: 'default' }, agentId: 'agent1', allowList: [], denyList: [] }],
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

  it('answers /help deterministically — no agent run, native conversation id', async () => {
    const gw = createDynamicGateway();
    const agent = makeFakeAgent();
    gw.registerAgent('agent1', agent);
    const adapter = makeFakeAdapter('tg1');
    await gw.registerChannel('tg1', adapter, {
      globalDenyList: [],
      routing: [{ condition: { type: 'default' }, agentId: 'agent1', allowList: [], denyList: [] }],
    });

    await adapter.trigger({
      channelId: 'tg1',
      conversationId: 'conv1',
      senderId: 'user1',
      senderName: 'User',
      text: '/help',
      timestamp: new Date(),
    });

    expect(agent.chat).not.toHaveBeenCalled();
    expect(adapter.send).toHaveBeenCalledWith('conv1', { text: SLASH_HELP });
  });

  it('answers /skills from the agent skill list (listSkills), no LLM call', async () => {
    const gw = createDynamicGateway();
    const skills = [{ name: 'summarize', description: 'Summarize text' }];
    const agent = {
      chat: vi.fn().mockImplementation(async function* () {
        yield { type: 'response', content: 'x' };
      }),
      listSkills: vi.fn().mockResolvedValue(skills),
    } as unknown as AgentClient;
    gw.registerAgent('agent1', agent);
    const adapter = makeFakeAdapter('tg1');
    await gw.registerChannel('tg1', adapter, {
      globalDenyList: [],
      routing: [{ condition: { type: 'default' }, agentId: 'agent1', allowList: [], denyList: [] }],
    });

    await adapter.trigger({
      channelId: 'tg1',
      conversationId: 'conv1',
      senderId: 'user1',
      senderName: 'User',
      text: '/skills',
      timestamp: new Date(),
    });

    expect(agent.chat).not.toHaveBeenCalled();
    expect(agent.listSkills).toHaveBeenCalled();
    expect(adapter.send).toHaveBeenCalledWith('conv1', { text: formatSkillList(skills) });
  });

  it('passes /skill:<name> through in canonical form for pi to expand', async () => {
    const gw = createDynamicGateway();
    const agent = makeFakeAgent();
    gw.registerAgent('agent1', agent);
    const adapter = makeFakeAdapter('tg1');
    await gw.registerChannel('tg1', adapter, {
      globalDenyList: [],
      routing: [{ condition: { type: 'default' }, agentId: 'agent1', allowList: [], denyList: [] }],
    });

    await adapter.trigger({
      channelId: 'tg1',
      conversationId: 'conv1',
      senderId: 'user1',
      senderName: 'User',
      text: '/skill:summarize go',
      timestamp: new Date(),
    });

    // Reaches the agent as `/skill:<name> [input]` (with the prefixed conversation
    // id) so pi's native prompt expander runs it deterministically.
    expect(agent.chat).toHaveBeenCalledWith('tg1', 'tg1:conv1', '/skill:summarize go');
  });

  it('normalizes a bare /<plugin>:<command> to pi canonical /skill:<plugin>:<command>', async () => {
    const gw = createDynamicGateway();
    const agent = makeFakeAgent();
    gw.registerAgent('agent1', agent);
    const adapter = makeFakeAdapter('tg1');
    await gw.registerChannel('tg1', adapter, {
      globalDenyList: [],
      routing: [{ condition: { type: 'default' }, agentId: 'agent1', allowList: [], denyList: [] }],
    });

    await adapter.trigger({
      channelId: 'tg1',
      conversationId: 'conv1',
      senderId: 'user1',
      senderName: 'User',
      text: '/demo:triage hello there',
      timestamp: new Date(),
    });

    // A bare plugin command would NOT match pi's `/skill:`-only expander, so the
    // gateway rewrites it to the canonical form before dispatch.
    expect(agent.chat).toHaveBeenCalledWith('tg1', 'tg1:conv1', '/skill:demo:triage hello there');
  });

  it('deregisterAgent stops adapter when no rules remain', async () => {
    const gw = createDynamicGateway();
    gw.registerAgent('agent1', makeFakeAgent());

    const adapter = makeFakeAdapter('telegram');
    await gw.registerChannel('tg1', adapter, {
      globalDenyList: [],
      routing: [{ condition: { type: 'default' }, agentId: 'agent1', allowList: [], denyList: [] }],
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
      routing: [{ condition: { type: 'default' }, agentId: 'agent1', allowList: [], denyList: [] }],
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
      routing: [{ condition: { type: 'default' }, agentId: 'agent1', allowList: [], denyList: [] }],
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
      routing: [{ condition: { type: 'default' }, agentId: 'agent1', allowList: [], denyList: [] }],
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

  it('stopChannel stops the adapter and removes it from the gateway', async () => {
    const gw = createDynamicGateway();
    gw.registerAgent('agent1', makeFakeAgent());
    const adapter = makeFakeAdapter('telegram');
    await gw.registerChannel('tg1', adapter, {
      globalDenyList: [],
      routing: [{ condition: { type: 'default' }, agentId: 'agent1', allowList: [], denyList: [] }],
    });

    const result = await gw.stopChannel('tg1');

    expect(result).toBe(true);
    expect(adapter.stop).toHaveBeenCalled();
    expect(gw.channelCount()).toBe(0);

    // Subsequent inbound messages should be no-ops because the channel
    // is gone from the gateway's state map.
    await adapter.trigger({
      channelId: 'tg1',
      conversationId: 'conv1',
      senderId: 'user1',
      senderName: 'User',
      text: 'hi',
      timestamp: new Date(),
    });
    // Agent was never registered with a message (the channel is gone)
  });

  it('stopChannel returns false for unknown channel', async () => {
    const gw = createDynamicGateway();
    const result = await gw.stopChannel('nonexistent');
    expect(result).toBe(false);
  });

  it('stopChannel does not rethrow if adapter.stop() fails', async () => {
    const gw = createDynamicGateway();
    gw.registerAgent('agent1', makeFakeAgent());
    const adapter = makeFakeAdapter('telegram');
    (adapter.stop as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('network dead'));
    await gw.registerChannel('tg1', adapter, {
      globalDenyList: [],
      routing: [{ condition: { type: 'default' }, agentId: 'agent1', allowList: [], denyList: [] }],
    });

    // Must still resolve true (channel is removed from routing tables)
    await expect(gw.stopChannel('tg1')).resolves.toBe(true);
    expect(gw.channelCount()).toBe(0);
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
      routing: [{ condition: { type: 'default' }, agentId: 'agent1', allowList: [], denyList: [] }],
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

describe('createDynamicGateway — messageHook (UserPromptSubmit on channel path)', () => {
  async function setup(
    messageHook?: Parameters<typeof createDynamicGateway>[0] extends infer O
      ? O extends { messageHook?: infer H }
        ? H
        : never
      : never,
  ) {
    const gw = createDynamicGateway({ messageHook });
    const agent = makeFakeAgent();
    gw.registerAgent('agent1', agent);
    const adapter = makeFakeAdapter('telegram');
    await gw.registerChannel('tg1', adapter, {
      globalDenyList: [],
      routing: [{ condition: { type: 'default' }, agentId: 'agent1', allowList: [], denyList: [] }],
    });
    return { gw, agent, adapter };
  }

  const baseMsg: InboundMessage = {
    channelId: 'tg1',
    conversationId: 'conv1',
    senderId: 'user1',
    senderName: 'User',
    text: 'hi',
    timestamp: new Date(),
  };

  it('blocks dispatch and sends the reason when the hook returns block:true', async () => {
    const { agent, adapter } = await setup(async () => ({ block: true, reason: 'blocked!' }));

    await adapter.trigger(baseMsg);

    expect(agent.chat).not.toHaveBeenCalled();
    expect(adapter.send).toHaveBeenCalledWith('conv1', { text: 'blocked!' });
  });

  it('blocks dispatch without sending when block:true has no reason', async () => {
    const { agent, adapter } = await setup(async () => ({ block: true }));

    await adapter.trigger(baseMsg);

    expect(agent.chat).not.toHaveBeenCalled();
    expect(adapter.send).not.toHaveBeenCalled();
  });

  it('prepends additionalContext to the prompt text', async () => {
    const { agent, adapter } = await setup(async () => ({
      block: false,
      additionalContext: 'CTX',
    }));

    await adapter.trigger({ ...baseMsg, text: 'hello' });

    expect(agent.chat).toHaveBeenCalledTimes(1);
    const promptArg = (agent.chat as ReturnType<typeof vi.fn>).mock.calls[0][2] as string;
    expect(promptArg.startsWith('CTX')).toBe(true);
    expect(promptArg).toContain('hello');
  });

  it('passes prompt + prefixed conversation id to the hook', async () => {
    const hook = vi.fn().mockResolvedValue({ block: false });
    const { adapter } = await setup(hook);

    await adapter.trigger({ ...baseMsg, text: 'ping' });

    expect(hook).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'ping',
        channel: 'tg1',
        conversationId: 'tg1:conv1',
        senderId: 'user1',
      }),
    );
  });

  it('fails open: dispatches unchanged when the hook throws', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { agent, adapter } = await setup(async () => {
      throw new Error('boom');
    });

    await adapter.trigger({ ...baseMsg, text: 'hello' });

    expect(agent.chat).toHaveBeenCalledTimes(1);
    expect((agent.chat as ReturnType<typeof vi.fn>).mock.calls[0][2]).toBe('hello');
    warnSpy.mockRestore();
  });

  it('dispatches unchanged when no messageHook is provided', async () => {
    const { agent, adapter } = await setup();

    await adapter.trigger({ ...baseMsg, text: 'hello' });

    expect(agent.chat).toHaveBeenCalledTimes(1);
    expect((agent.chat as ReturnType<typeof vi.fn>).mock.calls[0][2]).toBe('hello');
  });
});
