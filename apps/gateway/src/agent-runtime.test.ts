import type { AgentBackend, AgentEvent, AgentState, RunOptions } from '@dash/agent';
import { describe, expect, it } from 'vitest';
import { AgentRegistry } from './agent-registry.js';
import { AgentRuntime } from './agent-runtime.js';

function makeMockBackend(events: AgentEvent[]): AgentBackend {
  return {
    name: 'mock-backend',
    start: async () => {},
    stop: async () => {},
    abort: () => {},
    updateCredentials: async () => {},
    async *run(_state: AgentState, _options: RunOptions): AsyncGenerator<AgentEvent> {
      for (const event of events) {
        yield event;
      }
    },
  };
}

describe('AgentRuntime', () => {
  it('routes a message to the correct agent and streams events', async () => {
    const registry = new AgentRegistry();
    registry.register({
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

    const runtime = new AgentRuntime({
      registry,
      poolMaxSize: 10,
      sessionBaseDir: '/tmp/test-sessions',
      createBackend: async () => makeMockBackend(expectedEvents),
    });

    const collected: AgentEvent[] = [];
    for await (const event of runtime.chat({
      agentName: 'test-agent',
      conversationId: 'conv-1',
      text: 'Hi there',
    })) {
      collected.push(event);
    }

    expect(collected).toEqual(expectedEvents);
    await runtime.stop();
  });

  it('rejects messages to unknown agents (yields error event)', async () => {
    const registry = new AgentRegistry();
    const runtime = new AgentRuntime({
      registry,
      poolMaxSize: 10,
      sessionBaseDir: '/tmp/test-sessions',
      createBackend: async () => makeMockBackend([]),
    });

    const collected: AgentEvent[] = [];
    for await (const event of runtime.chat({
      agentName: 'nonexistent',
      conversationId: 'conv-1',
      text: 'Hello',
    })) {
      collected.push(event);
    }

    expect(collected).toHaveLength(1);
    expect(collected[0].type).toBe('error');
    const errorEvent = collected[0] as { type: 'error'; error: Error };
    expect(errorEvent.error.message).toMatch(/not found/);
    await runtime.stop();
  });

  it('rejects messages to disabled agents (yields error event)', async () => {
    const registry = new AgentRegistry();
    registry.register({
      name: 'disabled-agent',
      model: 'anthropic/claude-sonnet-4-20250514',
      systemPrompt: 'test',
    });
    registry.disable('disabled-agent');

    const runtime = new AgentRuntime({
      registry,
      poolMaxSize: 10,
      sessionBaseDir: '/tmp/test-sessions',
      createBackend: async () => makeMockBackend([]),
    });

    const collected: AgentEvent[] = [];
    for await (const event of runtime.chat({
      agentName: 'disabled-agent',
      conversationId: 'conv-1',
      text: 'Hello',
    })) {
      collected.push(event);
    }

    expect(collected).toHaveLength(1);
    expect(collected[0].type).toBe('error');
    const errorEvent = collected[0] as { type: 'error'; error: Error };
    expect(errorEvent.error.message).toMatch(/disabled/);
    await runtime.stop();
  });
});
