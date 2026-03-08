import { describe, expect, it } from 'vitest';
import type { DashAgent } from './agent.js';
import { LocalAgentClient } from './client.js';
import type { AgentEvent } from './types.js';

describe('LocalAgentClient', () => {
  it('delegates chat() to the underlying agent', async () => {
    const expectedEvents: AgentEvent[] = [
      { type: 'text_delta', text: 'Hello' },
      {
        type: 'response',
        content: 'Hello',
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    ];

    // Create a fake DashAgent with an async generator chat method
    const fakeAgent = {
      async *chat(
        _channelId: string,
        _conversationId: string,
        _text: string,
      ): AsyncGenerator<AgentEvent> {
        for (const event of expectedEvents) {
          yield event;
        }
      },
    } as unknown as DashAgent;

    const client = new LocalAgentClient(fakeAgent);
    const events: AgentEvent[] = [];

    for await (const event of client.chat('channel-1', 'conv-1', 'Hi')) {
      events.push(event);
    }

    expect(events).toEqual(expectedEvents);
  });

  it('passes channelId, conversationId, and text through', async () => {
    let receivedArgs: [string, string, string] | undefined;

    const fakeAgent = {
      // biome-ignore lint/correctness/useYield: test stub that captures args without yielding
      async *chat(
        channelId: string,
        conversationId: string,
        text: string,
      ): AsyncGenerator<AgentEvent> {
        receivedArgs = [channelId, conversationId, text];
      },
    } as unknown as DashAgent;

    const client = new LocalAgentClient(fakeAgent);

    // Consume the generator
    for await (const _ of client.chat('ch-1', 'conv-2', 'test message')) {
      // no events
    }

    expect(receivedArgs).toEqual(['ch-1', 'conv-2', 'test message']);
  });
});
