import type { AgentBackend, AgentEvent, AgentState, RunOptions } from '@dash/agent';
import { describe, expect, it } from 'vitest';
import { createAgentChatCoordinator } from './agent-chat-coordinator.js';
import { AgentRegistry } from './agent-registry.js';

function makeMockBackend(events: AgentEvent[]): AgentBackend {
  return {
    name: 'mock-backend',
    start: async () => {},
    stop: async () => {},
    abort: () => {},
    async *run(_state: AgentState, _options: RunOptions): AsyncGenerator<AgentEvent> {
      for (const event of events) {
        yield event;
      }
    },
  };
}

describe('AgentChatCoordinator', () => {
  it('routes a message to the correct agent and streams events', async () => {
    const registry = new AgentRegistry();
    const { id } = registry.register({
      name: 'test-agent',
      model: 'anthropic/claude-sonnet-4-20250514',
      systemPrompt: 'You are helpful.',
    });

    const expectedEvents: AgentEvent[] = [
      { type: 'text_delta', text: 'Hello' },
      {
        type: 'response',
        content: 'Hello',
        usage: { inputTokens: 10, outputTokens: 5 },
      },
    ];

    const agents = createAgentChatCoordinator({
      registry,
      poolMaxSize: 10,
      createBackend: async () => makeMockBackend(expectedEvents),
    });

    const collected: AgentEvent[] = [];
    for await (const event of agents.chat({
      agentId: id,
      conversationId: 'conv-1',
      text: 'Hi there',
    })) {
      collected.push(event);
    }

    expect(collected).toEqual(expectedEvents);
    await agents.stop();
  });

  it('rejects messages to unknown agents (yields error event)', async () => {
    const registry = new AgentRegistry();
    const agents = createAgentChatCoordinator({
      registry,
      poolMaxSize: 10,
      createBackend: async () => makeMockBackend([]),
    });

    const collected: AgentEvent[] = [];
    for await (const event of agents.chat({
      agentId: 'nonexistent-id',
      conversationId: 'conv-1',
      text: 'Hello',
    })) {
      collected.push(event);
    }

    expect(collected).toHaveLength(1);
    expect(collected[0].type).toBe('error');
    const errorEvent = collected[0] as { type: 'error'; error: Error };
    expect(errorEvent.error.message).toMatch(/not found/);
    await agents.stop();
  });

  it('rejects messages to disabled agents (yields error event)', async () => {
    const registry = new AgentRegistry();
    const { id } = registry.register({
      name: 'disabled-agent',
      model: 'anthropic/claude-sonnet-4-20250514',
      systemPrompt: 'test',
    });
    registry.disable(id);

    const agents = createAgentChatCoordinator({
      registry,
      poolMaxSize: 10,
      createBackend: async () => makeMockBackend([]),
    });

    const collected: AgentEvent[] = [];
    for await (const event of agents.chat({
      agentId: id,
      conversationId: 'conv-1',
      text: 'Hello',
    })) {
      collected.push(event);
    }

    expect(collected).toHaveLength(1);
    expect(collected[0].type).toBe('error');
    const errorEvent = collected[0] as { type: 'error'; error: Error };
    expect(errorEvent.error.message).toMatch(/disabled/);
    await agents.stop();
  });
});
