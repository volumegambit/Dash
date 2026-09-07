import type { AgentClient } from '@dash/agent';
import type { ChannelAdapter, InboundMessage } from '@dash/channels';
import { SLASH_HELP, formatSkillList } from '@dash/channels';
import { describe, expect, it, vi } from 'vitest';
import { GatewayAdmissionController } from './admission-controller.js';
import { ADAPTER_STOP_TIMEOUT_MS, createDynamicGateway } from './gateway.js';

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

    expect(agent.chat).toHaveBeenCalledWith('tg1', 'tg1:conv1', 'hi', {
      signal: expect.any(AbortSignal),
    });
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
    expect(adapter.send).toHaveBeenCalledWith(
      'conv1',
      { text: SLASH_HELP },
      expect.any(AbortSignal),
    );
  });

  it.each(['disable', 'delete'])(
    'aborts a signal-ignorant held reply and releases its lease during agent %s',
    async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const admission = new GatewayAdmissionController();
      const gateway = createDynamicGateway({ admission });
      const sendStarted = Promise.withResolvers<void>();
      const releaseSend = Promise.withResolvers<void>();
      let sendSignal: AbortSignal | undefined;
      const adapter = makeFakeAdapter('held-send');
      vi.mocked(adapter.send).mockImplementationOnce(
        async (_conversationId, _message, signal?: AbortSignal) => {
          sendSignal = signal;
          sendStarted.resolve();
          await releaseSend.promise;
        },
      );
      gateway.registerAgent('agent1', makeFakeAgent());
      await gateway.registerChannel('held-send', adapter, {
        globalDenyList: [],
        routing: [
          {
            condition: { type: 'default' },
            agentId: 'agent1',
            allowList: [],
            denyList: [],
          },
        ],
      });
      const inbound = adapter.trigger({
        channelId: 'held-send',
        conversationId: 'conv1',
        senderId: 'user1',
        senderName: 'User',
        text: '/help',
        timestamp: new Date('2026-09-07T00:00:00.000Z'),
      });
      await sendStarted.promise;

      const lifecycle = admission.beginAgentLifecycle('agent1');
      const draining = lifecycle.drainPrior();
      try {
        expect(sendSignal?.aborted).toBe(true);
        await inbound;
        await draining;
      } finally {
        releaseSend.resolve();
        await Promise.allSettled([inbound, draining]);
        lifecycle.finish();
        await gateway.stop();
        errorSpy.mockRestore();
      }
    },
  );

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
    expect(adapter.send).toHaveBeenCalledWith(
      'conv1',
      { text: formatSkillList(skills) },
      expect.any(AbortSignal),
    );
  });

  it('abandons a held /skills lookup when its agent lifecycle starts', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const admission = new GatewayAdmissionController();
    const gateway = createDynamicGateway({ admission });
    const lookupStarted = Promise.withResolvers<void>();
    const releaseLookup = Promise.withResolvers<void>();
    let lookupSignal: AbortSignal | undefined;
    gateway.registerAgent('agent1', {
      chat: vi.fn(),
      listSkills: vi.fn(async (signal?: AbortSignal) => {
        lookupSignal = signal;
        lookupStarted.resolve();
        await releaseLookup.promise;
        return [];
      }),
    } as unknown as AgentClient);
    const adapter = makeFakeAdapter('held-skills');
    await gateway.registerChannel('held-skills', adapter, {
      globalDenyList: [],
      routing: [
        {
          condition: { type: 'default' },
          agentId: 'agent1',
          allowList: [],
          denyList: [],
        },
      ],
    });
    let inboundSettled = false;
    const inbound = adapter
      .trigger({
        channelId: 'held-skills',
        conversationId: 'conv1',
        senderId: 'user1',
        senderName: 'User',
        text: '/skills',
        timestamp: new Date('2026-09-07T00:00:00.000Z'),
      })
      .finally(() => {
        inboundSettled = true;
      });
    await lookupStarted.promise;
    const lifecycle = admission.beginAgentLifecycle('agent1');
    const draining = lifecycle.drainPrior();

    try {
      expect(lookupSignal?.aborted).toBe(true);
      await vi.waitFor(() => expect(inboundSettled).toBe(true), { timeout: 100 });
      await draining;
    } finally {
      releaseLookup.resolve();
      await Promise.allSettled([inbound, draining]);
      lifecycle.finish();
      await gateway.stop();
      errorSpy.mockRestore();
    }
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
    expect(agent.chat).toHaveBeenCalledWith('tg1', 'tg1:conv1', '/skill:summarize go', {
      signal: expect.any(AbortSignal),
    });
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
    expect(agent.chat).toHaveBeenCalledWith('tg1', 'tg1:conv1', '/skill:demo:triage hello there', {
      signal: expect.any(AbortSignal),
    });
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
    expect(agentA.chat).toHaveBeenCalledWith('tg1', 'tg1:conv1', 'hi', {
      signal: expect.any(AbortSignal),
    });
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

    expect(agent.chat).toHaveBeenCalledWith('my-channel', 'my-channel:12345', 'hello', {
      signal: expect.any(AbortSignal),
    });
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
    expect(adapter.send).toHaveBeenCalledWith('conv1', { text: 'hello' }, expect.any(AbortSignal));
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
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
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
    warnSpy.mockRestore();
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
    expect(adapter.send).toHaveBeenCalledWith(
      'conv1',
      { text: 'blocked!' },
      expect.any(AbortSignal),
    );
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
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('abandons a held hook when its agent lifecycle starts', async () => {
    const admission = new GatewayAdmissionController();
    const hookStarted = Promise.withResolvers<void>();
    const releaseHook = Promise.withResolvers<void>();
    let hookSignal: AbortSignal | undefined;
    const gateway = createDynamicGateway({
      admission,
      messageHook: vi.fn(async (input) => {
        hookSignal = (input as typeof input & { signal?: AbortSignal }).signal;
        hookStarted.resolve();
        await releaseHook.promise;
        return { block: false };
      }),
    });
    gateway.registerAgent('agent1', makeFakeAgent());
    const adapter = makeFakeAdapter('held-hook');
    await gateway.registerChannel('held-hook', adapter, {
      globalDenyList: [],
      routing: [
        {
          condition: { type: 'default' },
          agentId: 'agent1',
          allowList: [],
          denyList: [],
        },
      ],
    });
    let inboundSettled = false;
    const inbound = adapter.trigger({ ...baseMsg, channelId: 'held-hook' }).finally(() => {
      inboundSettled = true;
    });
    await hookStarted.promise;
    const lifecycle = admission.beginAgentLifecycle('agent1');
    const draining = lifecycle.drainPrior();

    try {
      expect(hookSignal?.aborted).toBe(true);
      await vi.waitFor(() => expect(inboundSettled).toBe(true), { timeout: 100 });
      await draining;
    } finally {
      releaseHook.resolve();
      await Promise.allSettled([inbound, draining]);
      lifecycle.finish();
      await gateway.stop();
    }
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

describe('shutdown resilience', () => {
  async function registerChannelWith(
    gw: ReturnType<typeof createDynamicGateway>,
    name: string,
    adapter: ChannelAdapter,
    agentId = 'agent1',
  ) {
    await gw.registerChannel(name, adapter, {
      globalDenyList: [],
      routing: [{ condition: { type: 'default' }, agentId, allowList: [], denyList: [] }],
    });
  }

  it('stop() resolves and stops every adapter even when one stop() rejects', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const gw = createDynamicGateway();
    gw.registerAgent('agent1', makeFakeAgent());

    const failing = makeFakeAdapter('telegram');
    (failing.stop as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Network request for 'getUpdates' failed"),
    );
    const healthy = makeFakeAdapter('whatsapp');

    await registerChannelWith(gw, 'tg1', failing);
    await registerChannelWith(gw, 'wa1', healthy);

    await expect(gw.stop()).resolves.toBeUndefined();

    expect(healthy.stop).toHaveBeenCalled();
    expect(gw.channelCount()).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('tg1'),
      expect.stringContaining('getUpdates'),
    );
    warnSpy.mockRestore();
  });

  it('stop() resolves after the adapter-stop timeout when an adapter stop hangs', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const gw = createDynamicGateway();
      gw.registerAgent('agent1', makeFakeAgent());

      const hanging = makeFakeAdapter('telegram');
      (hanging.stop as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise(() => {}));
      await registerChannelWith(gw, 'tg1', hanging);

      let stopped = false;
      const stopPromise = gw.stop().then(() => {
        stopped = true;
      });
      await vi.advanceTimersByTimeAsync(ADAPTER_STOP_TIMEOUT_MS);
      await stopPromise;

      expect(stopped).toBe(true);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('tg1'),
        expect.stringContaining('timed out'),
      );
    } finally {
      warnSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('deregisterAgent resolves even when a removed channel adapter stop() rejects', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const gw = createDynamicGateway();
    gw.registerAgent('agent1', makeFakeAgent());

    const failing = makeFakeAdapter('telegram');
    (failing.stop as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('ETIMEDOUT'));
    await registerChannelWith(gw, 'tg1', failing);

    await expect(gw.deregisterAgent('agent1')).resolves.toEqual(['tg1']);
    expect(gw.channelCount()).toBe(0);
    warnSpy.mockRestore();
  });
});

describe('channel ingress lifecycle', () => {
  const routing = {
    globalDenyList: [] as string[],
    routing: [
      {
        condition: { type: 'default' as const },
        agentId: 'agent1',
        allowList: [] as string[],
        denyList: [] as string[],
      },
    ],
  };
  const message: InboundMessage = {
    channelId: 'restored',
    conversationId: 'conversation-1',
    senderId: 'user-1',
    senderName: 'User',
    text: 'hello after recovery',
    timestamp: new Date('2026-09-07T00:00:00.000Z'),
  };

  it('registers restored adapters without opening ingress until startChannel', async () => {
    const gateway = createDynamicGateway();
    const agent = makeFakeAgent();
    gateway.registerAgent('agent1', agent);
    const adapter = makeFakeAdapter('restored');
    const lifecycleGateway = gateway as typeof gateway & {
      registerChannel(
        name: string,
        adapter: ChannelAdapter,
        config: typeof routing,
        options: { start: false },
      ): Promise<void>;
      startChannel(name: string): Promise<boolean>;
    };

    await lifecycleGateway.registerChannel('restored', adapter, routing, { start: false });
    expect(adapter.start).not.toHaveBeenCalled();
    await adapter.trigger(message);
    expect(agent.chat).not.toHaveBeenCalled();

    await expect(lifecycleGateway.startChannel('restored')).resolves.toBe(true);
    expect(adapter.start).toHaveBeenCalledOnce();
    await adapter.trigger(message);
    expect(agent.chat).toHaveBeenCalledOnce();
  });

  it('drops channel calls after an agent or process admission fence', async () => {
    const admission = new GatewayAdmissionController();
    const gateway = createDynamicGateway({ admission } as unknown as Parameters<
      typeof createDynamicGateway
    >[0]);
    const agentA = makeFakeAgent();
    const agentB = makeFakeAgent();
    gateway.registerAgent('agent1', agentA);
    gateway.registerAgent('agent2', agentB);
    const adapterA = makeFakeAdapter('channel-a');
    const adapterB = makeFakeAdapter('channel-b');
    await gateway.registerChannel('channel-a', adapterA, routing);
    await gateway.registerChannel('channel-b', adapterB, {
      ...routing,
      routing: [{ ...routing.routing[0], agentId: 'agent2' }],
    });

    admission.closeAgent('agent1');
    await adapterA.trigger({ ...message, channelId: 'channel-a' });
    expect(agentA.chat).not.toHaveBeenCalled();

    await adapterB.trigger({ ...message, channelId: 'channel-b' });
    expect(agentB.chat).toHaveBeenCalledOnce();

    admission.beginProcessShutdown().finish();
    await adapterB.trigger({ ...message, channelId: 'channel-b', text: 'too late' });
    expect(agentB.chat).toHaveBeenCalledOnce();
  });

  it.each(['disable', 'delete'])(
    'passes the lease signal into chat and abandons a signal-ignorant stream during %s',
    async () => {
      const admission = new GatewayAdmissionController();
      const gateway = createDynamicGateway({ admission });
      const streamStarted = Promise.withResolvers<void>();
      const releaseStream = Promise.withResolvers<void>();
      let runSignal: AbortSignal | undefined;
      const agent = {
        chat: vi.fn(
          (
            _channelId: string,
            _conversationId: string,
            _text: string,
            options?: { signal?: AbortSignal },
          ) => {
            runSignal = options?.signal;
            return (async function* () {
              streamStarted.resolve();
              await releaseStream.promise;
              yield* [];
            })();
          },
        ),
      } as unknown as AgentClient;
      gateway.registerAgent('agent1', agent);
      const adapter = makeFakeAdapter('held-stream');
      await gateway.registerChannel('held-stream', adapter, routing);
      let inboundSettled = false;
      const inbound = adapter.trigger({ ...message, channelId: 'held-stream' }).finally(() => {
        inboundSettled = true;
      });
      await streamStarted.promise;
      const lifecycle = admission.beginAgentLifecycle('agent1');
      const draining = lifecycle.drainPrior();

      try {
        expect(runSignal?.aborted).toBe(true);
        await vi.waitFor(() => expect(inboundSettled).toBe(true), { timeout: 100 });
        await draining;
      } finally {
        releaseStream.resolve();
        await Promise.allSettled([inbound, draining]);
        lifecycle.finish();
        await gateway.stop();
      }
    },
  );

  it('stops accepting adapter callbacks synchronously while gateway stop is pending', async () => {
    let releaseStop!: () => void;
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    const gateway = createDynamicGateway();
    const agent = makeFakeAgent();
    gateway.registerAgent('agent1', agent);
    const adapter = makeFakeAdapter('restored');
    vi.mocked(adapter.stop).mockReturnValue(stopGate);
    await gateway.registerChannel('restored', adapter, routing);

    const stopping = gateway.stop();
    await adapter.trigger(message);
    expect(agent.chat).not.toHaveBeenCalled();

    releaseStop();
    await stopping;
  });

  it('rejects agent and channel registration after shutdown starts', async () => {
    const gateway = createDynamicGateway();
    await gateway.stop();
    const adapter = makeFakeAdapter('late');

    expect(() => gateway.registerAgent('late-agent', makeFakeAgent())).toThrow('shutting down');
    await expect(gateway.registerChannel('late', adapter, routing)).rejects.toThrow(
      'shutting down',
    );
    expect(gateway.agentCount()).toBe(0);
    expect(gateway.channelCount()).toBe(0);
    expect(adapter.start).not.toHaveBeenCalled();
  });

  it('stops an adapter whose deferred start crosses gateway shutdown', async () => {
    const gateway = createDynamicGateway();
    const adapter = makeFakeAdapter('restored');
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    vi.mocked(adapter.start).mockReturnValue(startGate);
    await gateway.registerChannel('restored', adapter, routing, { start: false });

    const starting = gateway.startChannel('restored');
    await vi.waitFor(() => expect(adapter.start).toHaveBeenCalledOnce());
    await gateway.stop();
    releaseStart();

    await expect(starting).rejects.toThrow('shutting down');
    expect(adapter.stop).toHaveBeenCalled();
    expect(gateway.channelCount()).toBe(0);
  });
});
