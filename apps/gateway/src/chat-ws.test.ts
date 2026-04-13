import type { AgentBackend, AgentEvent, AgentState, RunOptions } from '@dash/agent';
import { describe, expect, it } from 'vitest';
import type { AgentChatCoordinator } from './agent-chat-coordinator.js';
import { createAgentChatCoordinator } from './agent-chat-coordinator.js';
import { AgentRegistry } from './agent-registry.js';

/**
 * These tests verify that the AgentChatCoordinator — the core dependency
 * behind the /ws/chat WebSocket endpoint — correctly routes chat messages,
 * rejects unknown agents, and rejects disabled agents.
 *
 * The tests exercise the coordinator directly rather than going through a
 * real WebSocket connection, since the chat-ws module is a thin WebSocket
 * wrapper around AgentChatCoordinator.chat/steer/followUp.
 */

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

function makeAgents(registry: AgentRegistry, events: AgentEvent[] = []): AgentChatCoordinator {
  return createAgentChatCoordinator({
    registry,
    poolMaxSize: 10,
    createBackend: async () => makeMockBackend(events),
  });
}

describe('chat-ws agent service integration', () => {
  it('streams events for a valid message', async () => {
    const registry = new AgentRegistry();
    const { id } = registry.register({
      name: 'helper',
      model: 'anthropic/claude-sonnet-4-20250514',
      systemPrompt: 'You are helpful.',
    });

    const expectedEvents: AgentEvent[] = [
      { type: 'text_delta', text: 'Hi' },
      { type: 'response', content: 'Hi', usage: { inputTokens: 5, outputTokens: 2 } },
    ];

    const agents = makeAgents(registry, expectedEvents);
    const collected: AgentEvent[] = [];

    for await (const event of agents.chat({
      agentId: id,
      conversationId: 'conv-ws-1',
      channelId: 'direct',
      text: 'Hello',
    })) {
      collected.push(event);
    }

    expect(collected).toHaveLength(2);
    expect(collected[0]).toEqual({ type: 'text_delta', text: 'Hi' });
    expect(collected[1]).toEqual({
      type: 'response',
      content: 'Hi',
      usage: { inputTokens: 5, outputTokens: 2 },
    });

    await agents.stop();
  });

  it('yields error event for unknown agent', async () => {
    const registry = new AgentRegistry();
    const agents = makeAgents(registry);
    const collected: AgentEvent[] = [];

    for await (const event of agents.chat({
      agentId: 'does-not-exist-id',
      conversationId: 'conv-ws-2',
      channelId: 'direct',
      text: 'Hello',
    })) {
      collected.push(event);
    }

    expect(collected).toHaveLength(1);
    expect(collected[0].type).toBe('error');
    const errEvent = collected[0] as { type: 'error'; error: Error };
    expect(errEvent.error.message).toContain('not found');

    await agents.stop();
  });

  it('yields error event for disabled agent', async () => {
    const registry = new AgentRegistry();
    const { id: disabledId } = registry.register({
      name: 'disabled-bot',
      model: 'anthropic/claude-sonnet-4-20250514',
      systemPrompt: 'test',
    });
    registry.disable(disabledId);

    const agents = makeAgents(registry);
    const collected: AgentEvent[] = [];

    for await (const event of agents.chat({
      agentId: disabledId,
      conversationId: 'conv-ws-3',
      channelId: 'direct',
      text: 'Hello',
    })) {
      collected.push(event);
    }

    expect(collected).toHaveLength(1);
    expect(collected[0].type).toBe('error');
    const errEvent = collected[0] as { type: 'error'; error: Error };
    expect(errEvent.error.message).toContain('disabled');

    await agents.stop();
  });

  it('streams multiple events in order', async () => {
    const registry = new AgentRegistry();
    const { id: multiId } = registry.register({
      name: 'multi-agent',
      model: 'anthropic/claude-sonnet-4-20250514',
      systemPrompt: 'You help with math.',
    });

    const expectedEvents: AgentEvent[] = [
      { type: 'text_delta', text: '2' },
      { type: 'text_delta', text: '+' },
      { type: 'text_delta', text: '2' },
      { type: 'text_delta', text: '=' },
      { type: 'text_delta', text: '4' },
      { type: 'response', content: '2+2=4', usage: { inputTokens: 10, outputTokens: 5 } },
    ];

    const agents = makeAgents(registry, expectedEvents);
    const collected: AgentEvent[] = [];

    for await (const event of agents.chat({
      agentId: multiId,
      conversationId: 'conv-ws-4',
      channelId: 'direct',
      text: 'What is 2+2?',
    })) {
      collected.push(event);
    }

    expect(collected).toEqual(expectedEvents);
    await agents.stop();
  });
});
