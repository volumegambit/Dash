import type { AgentClient } from '@dash/agent';
import { describe, expect, it, vi } from 'vitest';
import { MessageRouter } from './router.js';
import type { ChannelAdapter, InboundMessage, RouterConfig } from './types.js';

function makeAdapter(): ChannelAdapter & {
  trigger: (msg: Partial<InboundMessage>) => Promise<void>;
} {
  let handler: ((msg: InboundMessage) => Promise<void>) | null = null;
  return {
    name: 'test',
    start: vi.fn(),
    stop: vi.fn(),
    send: vi.fn(),
    getHealth: () => 'connected',
    onHealthChange: vi.fn(),
    onMessage: (h) => {
      handler = h;
    },
    async trigger(msg: Partial<InboundMessage>) {
      await handler?.({
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

const config: RouterConfig = {
  globalDenyList: [],
  rules: [{ condition: { type: 'default' }, agentName: 'default', allowList: [], denyList: [] }],
};

function setup(agent: AgentClient): ReturnType<typeof makeAdapter> {
  const router = new MessageRouter(new Map([['default', agent]]));
  const adapter = makeAdapter();
  router.addAdapter(adapter, config);
  return adapter;
}

function generatorChat() {
  return vi.fn().mockImplementation(async function* () {
    yield { type: 'response', content: 'ok', usage: {} };
  });
}

describe('MessageRouter - slash commands', () => {
  it('/skills lists skills and does not call the agent', async () => {
    const chat = vi.fn();
    const listSkills = vi.fn().mockResolvedValue([
      {
        name: 'summarize-thread',
        description: 'condense',
        location: '',
        content: '',
        editable: false,
        source: 'bundled',
      },
    ]);
    const adapter = setup({ chat, listSkills } as unknown as AgentClient);
    await adapter.trigger({ text: '/skills' });
    expect(chat).not.toHaveBeenCalled();
    expect(adapter.send).toHaveBeenCalledWith('conv-1', {
      text: expect.stringContaining('summarize-thread'),
    });
  });

  it('/skill:<name> rewrites to a load-and-apply prompt for the agent', async () => {
    const chat = generatorChat();
    const adapter = setup({ chat } as unknown as AgentClient);
    await adapter.trigger({ text: '/skill:summarize hi there' });
    expect(chat).toHaveBeenCalledWith(
      'test',
      'conv-1',
      "Load and apply the skill 'summarize'. Input: hi there",
    );
  });

  it('/help replies with help and does not call the agent', async () => {
    const chat = vi.fn();
    const adapter = setup({ chat } as unknown as AgentClient);
    await adapter.trigger({ text: '/help' });
    expect(chat).not.toHaveBeenCalled();
    expect(adapter.send).toHaveBeenCalledWith('conv-1', {
      text: expect.stringContaining('/skills'),
    });
  });

  it('passes through normal messages unchanged', async () => {
    const chat = generatorChat();
    const adapter = setup({ chat } as unknown as AgentClient);
    await adapter.trigger({ text: 'hello there' });
    expect(chat).toHaveBeenCalledWith('test', 'conv-1', 'hello there');
  });

  it('passes through unknown slash commands unchanged', async () => {
    const chat = generatorChat();
    const adapter = setup({ chat } as unknown as AgentClient);
    await adapter.trigger({ text: '/unknown thing' });
    expect(chat).toHaveBeenCalledWith('test', 'conv-1', '/unknown thing');
  });

  it('falls through to the agent if the shim throws', async () => {
    const chat = generatorChat();
    const listSkills = vi.fn().mockRejectedValue(new Error('boom'));
    const adapter = setup({ chat, listSkills } as unknown as AgentClient);
    await adapter.trigger({ text: '/skills' });
    expect(chat).toHaveBeenCalledWith('test', 'conv-1', '/skills');
  });
});
