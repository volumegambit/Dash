import type { AgentBackend, AgentEvent, AgentState, RunOptions } from '@dash/agent';
import { describe, expect, it, vi } from 'vitest';
import { AgentRegistry } from './agent-registry.js';
import { AgentRuntime } from './agent-runtime.js';

describe('Gateway integration', () => {
  it('registers an agent and handles a chat message end-to-end', async () => {
    const registry = new AgentRegistry();
    const backend: AgentBackend = {
      name: 'test',
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      async *run(_state: AgentState, _options: RunOptions): AsyncGenerator<AgentEvent> {
        yield { type: 'text_delta', text: 'Hello!' };
        yield {
          type: 'response',
          content: 'Hello!',
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      },
      abort: vi.fn(),
      updateCredentials: vi.fn().mockResolvedValue(undefined),
    };

    const runtime = new AgentRuntime({
      registry,
      poolMaxSize: 10,
      sessionBaseDir: '/tmp/test-sessions',
      createBackend: vi.fn().mockResolvedValue(backend),
    });

    // Register agent
    registry.register({
      name: 'test-agent',
      model: 'anthropic/claude-sonnet-4-20250514',
      systemPrompt: 'You are a test agent.',
    });

    // Send message
    const events: AgentEvent[] = [];
    for await (const event of runtime.chat({
      agentName: 'test-agent',
      conversationId: 'conv-1',
      text: 'Hello',
    })) {
      events.push(event);
    }

    // Verify events
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: 'text_delta', text: 'Hello!' });
    expect(events[1]).toMatchObject({ type: 'response', content: 'Hello!' });

    // Agent should be active
    expect(registry.get('test-agent')?.status).toBe('active');

    // Pool should have one entry
    expect(runtime.stats().size).toBe(1);

    // Cleanup
    await runtime.stop();

    // Pool should be empty after stop
    expect(runtime.stats().size).toBe(0);

    // Backend stop should have been called
    expect(backend.stop).toHaveBeenCalled();
  });
});
