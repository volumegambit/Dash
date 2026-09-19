import type { AgentEvent } from '@dash/agent';
import type { WorkerSpec, WorkerStatus } from './types.js';

describe('subagent types', () => {
  it('accepts the extended WorkerSpec and statuses', () => {
    const spec: WorkerSpec = {
      agentId: 'a',
      agentName: 'n',
      runId: 'r',
      workerId: 'w',
      role: 'x',
      brief: 'b',
      model: 'anthropic/claude-opus-5',
      workspace: '/tmp',
      tools: ['read'],
      extraTools: [],
      subagentType: 'Explore',
      description: 'map code',
      name: 'mapper',
      background: true,
      isolation: 'worktree',
      skipMemory: true,
      maxTurns: 10,
      oneShot: true,
      depth: 1,
    };
    const status: WorkerStatus = 'max_turns';
    const ev: AgentEvent = {
      type: 'subagent_finished',
      subagentId: 'w',
      subagentType: 'Explore',
      description: 'map code',
      status,
      report: 'done',
      toolCallCount: 3,
      startedAt: '2026-09-04T00:00:00Z',
      endedAt: '2026-09-04T00:01:00Z',
    };
    expect(spec.name).toBe('mapper');
    expect(ev.type).toBe('subagent_finished');
  });
});
