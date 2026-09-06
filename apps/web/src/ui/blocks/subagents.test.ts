import type { MobileAgentEvent } from '@dash/mobile-contract';
import {
  clusterAdjacent,
  formatClusterSummary,
  formatElapsed,
  formatToolCount,
  groupSubagentEvents,
  isTerminalSubagentStatus,
} from './subagents.js';

const START_ISO = '2026-09-04T00:00:00.000Z';
const END_ISO = '2026-09-04T00:01:12.000Z';

function started(id: string, over: Record<string, unknown> = {}): MobileAgentEvent {
  return {
    type: 'subagent_started',
    subagentId: id,
    name: 'reviewer',
    subagentType: 'code-reviewer',
    description: 'Review the diff',
    prompt: 'Review the diff and report findings',
    model: 'anthropic/claude-opus-4',
    background: false,
    depth: 1,
    startedAt: START_ISO,
    ...over,
  };
}

function progress(id: string, over: Record<string, unknown> = {}): MobileAgentEvent {
  return {
    type: 'subagent_progress',
    subagentId: id,
    status: 'running',
    toolCallCount: 3,
    elapsedMs: 7200,
    detail: 'reading files',
    ...over,
  };
}

function finished(id: string, over: Record<string, unknown> = {}): MobileAgentEvent {
  return {
    type: 'subagent_finished',
    subagentId: id,
    name: 'reviewer',
    subagentType: 'code-reviewer',
    description: 'Review the diff',
    status: 'done',
    report: 'Two findings, both minor.',
    usage: { inputTokens: 1200, outputTokens: 340 },
    toolCallCount: 5,
    startedAt: START_ISO,
    endedAt: END_ISO,
    ...over,
  };
}

function text(t: string): MobileAgentEvent {
  return { type: 'text_delta', text: t };
}

function workerSpawned(id: string, over: Record<string, unknown> = {}): MobileAgentEvent {
  return {
    type: 'worker_spawned',
    workerId: id,
    runId: 'run_1',
    role: 'reviewer',
    brief: 'Review the diff',
    model: 'anthropic/claude-opus-4',
    ...over,
  };
}

function workerStatus(id: string, over: Record<string, unknown> = {}): MobileAgentEvent {
  return {
    type: 'worker_status',
    workerId: id,
    runId: 'run_1',
    role: 'reviewer',
    status: 'running',
    ...over,
  };
}

function workerDone(id: string, over: Record<string, unknown> = {}): MobileAgentEvent {
  return {
    type: 'worker_done',
    workerId: id,
    runId: 'run_1',
    role: 'reviewer',
    status: 'done',
    report: 'Legacy report.',
    ...over,
  };
}

describe('groupSubagentEvents', () => {
  it('folds a started → progress → finished sequence into one group', () => {
    const events = [text('hi'), started('a'), progress('a'), finished('a')];
    const groups = groupSubagentEvents(events, false);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      subagentId: 'a',
      name: 'reviewer',
      type: 'code-reviewer',
      description: 'Review the diff',
      status: 'done',
      background: false,
      depth: 1,
      startedAt: START_ISO,
      endedAt: END_ISO,
      toolCallCount: 5,
      report: 'Two findings, both minor.',
      anchorIndex: 1,
      orphan: false,
    });
  });

  it('ignores non-subagent events entirely', () => {
    expect(groupSubagentEvents([text('a'), text('b')], true)).toEqual([]);
  });

  it('anchors at the started event and keeps first-seen order', () => {
    const events = [started('a'), text('x'), started('b'), finished('a')];
    const groups = groupSubagentEvents(events, false);
    expect(groups.map((g) => g.subagentId)).toEqual(['a', 'b']);
    expect(groups.map((g) => g.anchorIndex)).toEqual([0, 2]);
  });

  it('carries the newest progress detail and toolCallCount while running', () => {
    const events = [
      started('a'),
      progress('a', { detail: 'reading files', toolCallCount: 2 }),
      progress('a', { detail: 'writing report', toolCallCount: 7 }),
    ];
    const [group] = groupSubagentEvents(events, true);
    expect(group.detail).toBe('writing report');
    expect(group.toolCallCount).toBe(7);
    expect(group.status).toBe('running');
  });

  it('surfaces a waiting_input question and the waiting status', () => {
    const events = [started('a'), progress('a', { status: 'waiting_input', question: 'Proceed?' })];
    const [group] = groupSubagentEvents(events, true);
    expect(group.status).toBe('waiting');
    expect(group.question).toBe('Proceed?');
    expect(group.detail).toBe('Proceed?');
  });

  it('keeps the newest NON-EMPTY detail (MC latestWorkerDetail semantics)', () => {
    const events = [
      started('a'),
      progress('a', { detail: 'reading files' }),
      progress('a', { detail: undefined }),
    ];
    const [group] = groupSubagentEvents(events, true);
    expect(group.detail).toBe('reading files');
  });

  it('clears the question once the child stops waiting', () => {
    const events = [
      started('a'),
      progress('a', { status: 'waiting_input', question: 'Proceed?' }),
      progress('a', { status: 'running', detail: undefined }),
    ];
    const [group] = groupSubagentEvents(events, true);
    expect(group.status).toBe('running');
    expect(group.question).toBeUndefined();
    // The answered question is still the newest thing the child said.
    expect(group.detail).toBe('Proceed?');
  });

  it('does not let a stale worker_status question survive a modern running progress', () => {
    // The mirror emits waiting+question, then only the canonical family
    // reports the child resumed. `modern ?? legacy` alone would leak the
    // answered question back onto a running row.
    const events = [
      started('a'),
      workerStatus('a', { status: 'waiting_input', question: 'Which branch?' }),
      progress('a', { status: 'waiting_input', question: 'Which branch?' }),
      progress('a', { status: 'running', detail: 'checking out' }),
    ];
    const [group] = groupSubagentEvents(events, true);
    expect(group.status).toBe('running');
    expect(group.question).toBeUndefined();
    expect(group.detail).toBe('checking out');
  });

  it('drops the pending question once the child is terminal', () => {
    // Cancelling a turn while a child waits on input goes straight from
    // waiting to `subagent_finished` with no intervening running progress
    // (child-handle.ts finalize). §8.1 makes `question` the trigger for the
    // inline reply affordance, so a terminal row must not carry one.
    const events = [
      started('a'),
      progress('a', { status: 'waiting_input', question: 'Which branch?' }),
      finished('a', { status: 'cancelled' }),
    ];
    const [group] = groupSubagentEvents(events, true);
    expect(group.status).toBe('cancelled');
    expect(group.question).toBeUndefined();
    // Still the last thing the child said, so the collapsed line keeps it.
    expect(group.detail).toBe('Which branch?');
  });

  it('drops the pending question when only the legacy mirror terminalizes', () => {
    const events = [
      workerSpawned('a'),
      workerStatus('a', { status: 'waiting_input', question: 'Which branch?' }),
      workerDone('a', { status: 'cancelled' }),
    ];
    const [group] = groupSubagentEvents(events, true);
    expect(group.status).toBe('cancelled');
    expect(group.question).toBeUndefined();
  });

  it('drops the pending question when end-of-stream terminalizes the row', () => {
    const events = [started('a'), progress('a', { status: 'waiting_input', question: 'Which?' })];
    const [group] = groupSubagentEvents(events, false);
    expect(group.status).toBe('cancelled');
    expect(group.question).toBeUndefined();
  });

  it('does not let a later subagent_started blank background and depth', () => {
    const events = [
      started('a', { background: true, depth: 2 }),
      {
        type: 'subagent_started',
        subagentId: 'a',
        subagentType: 'code-reviewer',
        description: 'Review the diff',
        prompt: 'Review the diff and report findings',
        model: 'anthropic/claude-opus-4',
        startedAt: START_ISO,
      } as MobileAgentEvent,
    ];
    const [group] = groupSubagentEvents(events, true);
    expect(group.background).toBe(true);
    expect(group.depth).toBe(2);
  });

  it('falls back to the description when no progress detail has arrived', () => {
    const [group] = groupSubagentEvents([started('a')], true);
    expect(group.detail).toBe('Review the diff');
  });

  describe('end-of-stream terminalization (ported from MC deriveWorkerStatus)', () => {
    it('keeps a group with no terminal event running while streaming', () => {
      const [group] = groupSubagentEvents([started('a'), progress('a')], true);
      expect(group.status).toBe('running');
      expect(group.endedAt).toBeUndefined();
    });

    it('marks a group with no terminal event cancelled once the stream ends', () => {
      const [group] = groupSubagentEvents([started('a'), progress('a')], false);
      expect(group.status).toBe('cancelled');
    });

    // Task D2 fix item 4: a `background: true` child is spawned to OUTLIVE the
    // turn (design §6), so the parent's message ending says nothing about it.
    // Terminalizing it to `cancelled` renders a healthy agent as dead in every
    // finished message that spawned one.
    it('leaves a background child running when the stream ends without a terminal event', () => {
      const [group] = groupSubagentEvents(
        [started('a', { background: true }), progress('a')],
        false,
      );
      expect(group.status).toBe('running');
      expect(group.background).toBe(true);
    });

    it('still honours a real terminal status for a background child', () => {
      const [group] = groupSubagentEvents(
        [started('a', { background: true }), finished('a', { status: 'done' })],
        false,
      );
      expect(group.status).toBe('done');
    });

    it('keeps a background child waiting when that is the last thing it reported', () => {
      const [group] = groupSubagentEvents(
        [
          started('a', { background: true }),
          progress('a', { status: 'waiting_input', question: 'Which branch?' }),
        ],
        false,
      );
      expect(group.status).toBe('waiting');
      expect(group.question).toBe('Which branch?');
    });

    it('never overrides a real terminal status when the stream ends', () => {
      const [group] = groupSubagentEvents(
        [started('a'), finished('a', { status: 'failed' })],
        false,
      );
      expect(group.status).toBe('failed');
    });
  });

  describe('orphan terminals (crash-split messages, ported from MC)', () => {
    it('marks a finished-without-started group as an orphan anchored at the terminal', () => {
      const groups = groupSubagentEvents([text('x'), finished('a')], false);
      expect(groups).toHaveLength(1);
      expect(groups[0]).toMatchObject({
        subagentId: 'a',
        orphan: true,
        anchorIndex: 1,
        status: 'done',
      });
    });

    it('de-orphans a group as soon as a start event arrives', () => {
      const groups = groupSubagentEvents([progress('a'), started('a')], true);
      expect(groups[0].orphan).toBe(false);
      expect(groups[0].anchorIndex).toBe(1);
    });
  });

  describe('legacy worker_* mirrors (removed in D8)', () => {
    it('folds worker_* and subagent_* for the same child into ONE group', () => {
      const events = [
        workerSpawned('a'),
        { type: 'agent_spawned', name: 'reviewer' } as MobileAgentEvent,
        started('a'),
        workerStatus('a', { detail: 'legacy detail' }),
        progress('a', { detail: 'modern detail', toolCallCount: 4 }),
        workerDone('a'),
        finished('a'),
      ];
      const groups = groupSubagentEvents(events, false);
      expect(groups).toHaveLength(1);
      expect(groups[0].subagentId).toBe('a');
    });

    it('anchors the merged group at the FIRST start event (the legacy mirror)', () => {
      const groups = groupSubagentEvents([workerSpawned('a'), started('a')], true);
      expect(groups[0].anchorIndex).toBe(0);
      expect(groups[0].orphan).toBe(false);
    });

    it('lets subagent_* fields win over worker_* regardless of arrival order', () => {
      const forward = groupSubagentEvents([workerSpawned('a'), started('a')], true)[0];
      const reversed = groupSubagentEvents([started('a'), workerSpawned('a')], true)[0];
      for (const group of [forward, reversed]) {
        expect(group.type).toBe('code-reviewer');
        expect(group.description).toBe('Review the diff');
        expect(group.startedAt).toBe(START_ISO);
      }
    });

    it('lets subagent_finished win over worker_done regardless of arrival order', () => {
      const forward = groupSubagentEvents(
        [started('a'), workerDone('a', { status: 'cancelled' }), finished('a')],
        false,
      )[0];
      const reversed = groupSubagentEvents(
        [started('a'), finished('a'), workerDone('a', { status: 'cancelled' })],
        false,
      )[0];
      for (const group of [forward, reversed]) {
        expect(group.status).toBe('done');
        expect(group.report).toBe('Two findings, both minor.');
        expect(group.toolCallCount).toBe(5);
      }
    });

    it('renders a legacy-only child from worker_* alone', () => {
      const events = [
        workerSpawned('a'),
        workerStatus('a', { detail: 'digging' }),
        workerDone('a'),
      ];
      const [group] = groupSubagentEvents(events, false);
      expect(group).toMatchObject({
        subagentId: 'a',
        type: 'reviewer',
        description: 'Review the diff',
        status: 'done',
        report: 'Legacy report.',
        startedAt: '',
        orphan: false,
      });
    });

    it('maps worker_status waiting_input to waiting and carries the question', () => {
      const events = [
        workerSpawned('a'),
        workerStatus('a', { status: 'waiting_input', question: 'Which branch?' }),
      ];
      const [group] = groupSubagentEvents(events, true);
      expect(group.status).toBe('waiting');
      expect(group.question).toBe('Which branch?');
    });
  });

  it('preserves interrupted and max_turns terminal statuses', () => {
    const a = groupSubagentEvents(
      [started('a'), finished('a', { status: 'interrupted' })],
      false,
    )[0];
    const b = groupSubagentEvents([started('b'), finished('b', { status: 'max_turns' })], false)[0];
    expect(a.status).toBe('interrupted');
    expect(b.status).toBe('max_turns');
  });
});

describe('isTerminalSubagentStatus', () => {
  it('treats every finished outcome as terminal', () => {
    for (const s of ['done', 'failed', 'cancelled', 'interrupted', 'max_turns'] as const) {
      expect(isTerminalSubagentStatus(s)).toBe(true);
    }
  });

  it('treats live states as non-terminal', () => {
    expect(isTerminalSubagentStatus('running')).toBe(false);
    expect(isTerminalSubagentStatus('waiting')).toBe(false);
  });
});

describe('clusterAdjacent', () => {
  it('clusters children whose start events are adjacent', () => {
    const events = [started('a'), started('b'), started('c')];
    const clusters = clusterAdjacent(groupSubagentEvents(events, true));
    expect(clusters.map((c) => c.map((g) => g.subagentId))).toEqual([['a', 'b', 'c']]);
  });

  it('clusters across the interleaved legacy mirrors and agent_spawned chrome', () => {
    const events = [
      workerSpawned('a'),
      { type: 'agent_spawned', name: 'reviewer' } as MobileAgentEvent,
      started('a'),
      workerSpawned('b'),
      { type: 'agent_spawned', name: 'reviewer' } as MobileAgentEvent,
      started('b'),
    ];
    const clusters = clusterAdjacent(groupSubagentEvents(events, true));
    expect(clusters.map((c) => c.map((g) => g.subagentId))).toEqual([['a', 'b']]);
  });

  it('splits a cluster when other content sits between two starts', () => {
    const events = [started('a'), text('thinking out loud'), started('b')];
    const clusters = clusterAdjacent(groupSubagentEvents(events, true));
    expect(clusters.map((c) => c.map((g) => g.subagentId))).toEqual([['a'], ['b']]);
  });

  it('keeps a later child in the same cluster when only its siblings events intervene', () => {
    const events = [started('a'), started('b'), progress('a'), progress('b'), started('c')];
    const clusters = clusterAdjacent(groupSubagentEvents(events, true));
    expect(clusters.map((c) => c.map((g) => g.subagentId))).toEqual([['a', 'b', 'c']]);
  });

  it('never clusters an orphan terminal with anything', () => {
    const events = [finished('a'), started('b'), started('c')];
    const clusters = clusterAdjacent(groupSubagentEvents(events, false));
    expect(clusters.map((c) => c.map((g) => g.subagentId))).toEqual([['a'], ['b', 'c']]);
  });

  it('returns an empty list for no groups', () => {
    expect(clusterAdjacent([])).toEqual([]);
  });
});

describe('formatClusterSummary', () => {
  it('summarizes a mixed cluster as "N agents · R running · D done"', () => {
    const events = [started('a'), started('b'), started('c'), finished('c')];
    const [cluster] = clusterAdjacent(groupSubagentEvents(events, true));
    expect(formatClusterSummary(cluster)).toBe('3 agents · 2 running · 1 done');
  });

  it('singularizes one agent and omits empty buckets', () => {
    const [cluster] = clusterAdjacent(groupSubagentEvents([started('a')], true));
    expect(formatClusterSummary(cluster)).toBe('1 agent · 1 running');
  });

  it('counts waiting and failed children', () => {
    const events = [
      started('a'),
      progress('a', { status: 'waiting_input', question: 'ok?' }),
      started('b'),
      finished('b', { status: 'failed' }),
    ];
    const [cluster] = clusterAdjacent(groupSubagentEvents(events, true));
    expect(formatClusterSummary(cluster)).toBe('2 agents · 1 waiting · 1 failed');
  });
});

describe('formatElapsed', () => {
  it('formats sub-minute durations as whole seconds', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(45_000)).toBe('45s');
    expect(formatElapsed(59_999)).toBe('59s');
  });

  it('formats sub-hour durations as minutes and zero-padded seconds', () => {
    expect(formatElapsed(60_000)).toBe('1m 00s');
    expect(formatElapsed(72_000)).toBe('1m 12s');
    expect(formatElapsed(3_599_999)).toBe('59m 59s');
  });

  it('formats hour-plus durations as hours and zero-padded minutes', () => {
    expect(formatElapsed(3_600_000)).toBe('1h 00m');
    expect(formatElapsed(7_380_000)).toBe('2h 03m');
  });

  it('clamps negative and non-finite input to zero', () => {
    expect(formatElapsed(-5_000)).toBe('0s');
    expect(formatElapsed(Number.NaN)).toBe('0s');
  });
});

describe('formatToolCount', () => {
  it('singularizes exactly one', () => {
    expect(formatToolCount(1)).toBe('1 tool use');
  });

  it('pluralizes zero and many', () => {
    expect(formatToolCount(0)).toBe('0 tool uses');
    expect(formatToolCount(12)).toBe('12 tool uses');
  });
});
