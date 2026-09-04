import type { AgentEvent } from '@dash/agent';
import { isTransientAgentEvent } from './transient-events.js';

describe('isTransientAgentEvent', () => {
  it('marks subagent_progress transient', () => {
    const progress: AgentEvent = {
      type: 'subagent_progress',
      subagentId: 'w-1',
      status: 'running',
      toolCallCount: 2,
      elapsedMs: 1000,
    };
    expect(isTransientAgentEvent(progress)).toBe(true);
  });

  it('marks every other event durable — including the subagent lifecycle pair', () => {
    const durable: AgentEvent[] = [
      { type: 'text_delta', text: 'hi' },
      { type: 'worker_status', workerId: 'w-1', runId: 'r-1', role: 'r', status: 'running' },
      {
        type: 'subagent_started',
        subagentId: 'w-1',
        subagentType: 'general-purpose',
        description: 'r',
        prompt: 'b',
        model: 'm',
        background: false,
        depth: 1,
        startedAt: '2026-09-05T00:00:00.000Z',
      },
      {
        type: 'subagent_finished',
        subagentId: 'w-1',
        subagentType: 'general-purpose',
        description: 'r',
        status: 'done',
        report: 'r',
        toolCallCount: 0,
        startedAt: '2026-09-05T00:00:00.000Z',
        endedAt: '2026-09-05T00:00:01.000Z',
      },
    ];
    for (const event of durable) {
      expect(isTransientAgentEvent(event)).toBe(false);
    }
  });
});
