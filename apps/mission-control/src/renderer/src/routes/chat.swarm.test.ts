import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SubagentListEntry } from '@dash/mobile-contract';
import { describe, expect, it } from 'vitest';
import type { McAgentEvent } from '../../../shared/ipc.js';
import {
  type SubagentGroup,
  clusterAdjacent,
  formatClusterSummary,
  formatElapsed,
  formatToolCount,
  groupSubagentEvents,
  isSubagentEvent,
  isTerminalSubagentStatus,
  resolveSubagentQuestion,
  resolveSubagentStatus,
  rowStatusOf,
  subagentElapsedMs,
  subagentReportSummary,
  summarizeSwarmStrip,
} from './chat.swarm.js';

const START_ISO = '2026-09-04T00:00:00.000Z';
const END_ISO = '2026-09-04T00:01:12.000Z';

function started(id: string, over: Record<string, unknown> = {}): McAgentEvent {
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
  } as McAgentEvent;
}

function progress(id: string, over: Record<string, unknown> = {}): McAgentEvent {
  return {
    type: 'subagent_progress',
    subagentId: id,
    status: 'running',
    toolCallCount: 3,
    elapsedMs: 7200,
    detail: 'reading files',
    ...over,
  } as McAgentEvent;
}

function finished(id: string, over: Record<string, unknown> = {}): McAgentEvent {
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
  } as McAgentEvent;
}

function text(t: string): McAgentEvent {
  return { type: 'text_delta', text: t };
}

function workerSpawned(id: string, over: Record<string, unknown> = {}): McAgentEvent {
  return {
    type: 'worker_spawned',
    workerId: id,
    runId: 'run_1',
    role: 'reviewer',
    brief: 'Review the diff',
    model: 'anthropic/claude-opus-4',
    ...over,
  } as McAgentEvent;
}

function workerStatus(id: string, over: Record<string, unknown> = {}): McAgentEvent {
  return {
    type: 'worker_status',
    workerId: id,
    runId: 'run_1',
    role: 'reviewer',
    status: 'running',
    ...over,
  } as McAgentEvent;
}

function workerDone(id: string, over: Record<string, unknown> = {}): McAgentEvent {
  return {
    type: 'worker_done',
    workerId: id,
    runId: 'run_1',
    role: 'reviewer',
    status: 'done',
    report: 'Legacy report.',
    ...over,
  } as McAgentEvent;
}

function listEntry(over: Partial<SubagentListEntry> = {}): SubagentListEntry {
  return {
    id: 'a',
    type: 'code-reviewer',
    description: 'Review the diff',
    status: 'running',
    background: false,
    depth: 1,
    startedAt: START_ISO,
    toolCallCount: 4,
    oneShot: false,
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

  // Divergence 3 of the three D1 found: groups come out in ANCHOR order, not in
  // the order their ids were first seen. The two sequences only differ when a
  // child's first event in the message is not its start — crash-reconcile and
  // mid-turn attach both produce that — so the test above, whose fixture has
  // the same order either way, cannot fail when the sort is removed.
  it('orders groups by anchor even when a child is first seen on a non-start event', () => {
    const events = [workerStatus('b'), started('a'), started('b')];
    const groups = groupSubagentEvents(events, true);
    expect(groups.map((g) => g.subagentId)).toEqual(['a', 'b']);
    expect(groups.map((g) => g.anchorIndex)).toEqual([1, 2]);
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

  it('keeps the newest NON-EMPTY detail (the old latestWorkerDetail semantics)', () => {
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
    expect(group.detail).toBe('Proceed?');
  });

  it('drops the pending question once the child is terminal', () => {
    const events = [
      started('a'),
      progress('a', { status: 'waiting_input', question: 'Which branch?' }),
      finished('a', { status: 'cancelled' }),
    ];
    const [group] = groupSubagentEvents(events, true);
    expect(group.status).toBe('cancelled');
    expect(group.question).toBeUndefined();
    expect(group.detail).toBe('Which branch?');
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
      } as McAgentEvent,
    ];
    const [group] = groupSubagentEvents(events, true);
    expect(group.background).toBe(true);
    expect(group.depth).toBe(2);
  });

  it('falls back to the description when no progress detail has arrived', () => {
    const [group] = groupSubagentEvents([started('a')], true);
    expect(group.detail).toBe('Review the diff');
  });

  describe('end-of-stream terminalization (the old deriveWorkerStatus)', () => {
    it('keeps a group with no terminal event running while streaming', () => {
      const [group] = groupSubagentEvents([started('a'), progress('a')], true);
      expect(group.status).toBe('running');
      expect(group.endedAt).toBeUndefined();
    });

    it('marks a group with no terminal event cancelled once the stream ends', () => {
      const [group] = groupSubagentEvents([started('a'), progress('a')], false);
      expect(group.status).toBe('cancelled');
    });

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

  describe('orphan terminals (crash-split messages)', () => {
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

  /**
   * D8 retired the `worker_*` mirrors. Nothing emits one, but a transcript
   * PERSISTED before D8 still contains them, and the policy is that the client
   * DROPS them: they anchor nothing, contribute nothing, and — because
   * `isSubagentEvent` still claims them — never reach the renderer's
   * "Activity from a newer Dash version" fallback.
   */
  describe('a persisted PRE-D8 transcript', () => {
    it('renders one normal card from the canonical half alone', () => {
      const events = [
        workerSpawned('a'),
        { type: 'agent_spawned', name: 'reviewer' } as McAgentEvent,
        started('a'),
        workerStatus('a', { detail: 'legacy detail' }),
        progress('a', { detail: 'modern detail', toolCallCount: 4 }),
        workerDone('a'),
        finished('a'),
      ];
      const groups = groupSubagentEvents(events, false);
      expect(groups).toHaveLength(1);
      expect(groups[0]).toMatchObject({
        subagentId: 'a',
        type: 'code-reviewer',
        description: 'Review the diff',
        status: 'done',
        report: 'Two findings, both minor.',
        startedAt: START_ISO,
        orphan: false,
        detail: 'modern detail',
      });
    });

    it('anchors at subagent_started, NOT at the retired worker_spawned before it', () => {
      const groups = groupSubagentEvents([workerSpawned('a'), started('a')], true);
      expect(groups[0].anchorIndex).toBe(1);
      expect(groups[0].orphan).toBe(false);
    });

    it('takes model and usage from the canonical family only', () => {
      // These were the two last-writer-wins slots written by BOTH families.
      const modelReversed = groupSubagentEvents(
        [started('a', { model: 'modern-model' }), workerSpawned('a', { model: 'legacy-model' })],
        true,
      )[0];
      expect(modelReversed.model).toBe('modern-model');

      const usageReversed = groupSubagentEvents(
        [
          started('a'),
          finished('a'),
          workerDone('a', { usage: { inputTokens: 1, outputTokens: 2 } }),
        ],
        false,
      )[0];
      expect(usageReversed.usage).toEqual({ inputTokens: 1200, outputTokens: 340 });
    });

    it('creates NO card for a legacy-only child (nothing canonical ever arrived)', () => {
      const events = [
        workerSpawned('a'),
        workerStatus('a', { detail: 'digging' }),
        workerDone('a'),
      ];
      expect(groupSubagentEvents(events, false)).toEqual([]);
    });

    it('a retired mirror contributes no field, in either arrival order', () => {
      const forward = groupSubagentEvents(
        [started('a'), workerDone('a', { status: 'cancelled' })],
        false,
      )[0];
      const reversed = groupSubagentEvents(
        [workerDone('a', { status: 'cancelled' }), started('a')],
        false,
      )[0];
      for (const group of [forward, reversed]) {
        // No canonical terminal arrived, so end-of-stream terminalization
        // applies — the retired `cancelled` is NOT the source.
        expect(group.status).toBe('cancelled');
        expect(group.report).toBeUndefined();
        expect(group.type).toBe('code-reviewer');
      }
    });

    it('a retired worker_status leaves no question and no live status on the card', () => {
      const events = [
        started('a'),
        workerStatus('a', { status: 'waiting_input', question: 'Which branch?' }),
      ];
      const [group] = groupSubagentEvents(events, true);
      expect(group.status).toBe('running');
      expect(group.question).toBeUndefined();
      expect(group.detail).toBe('Review the diff');
    });

    it('still counts as sub-agent chrome, so the renderer never falls back on it', () => {
      expect(isSubagentEvent('worker_spawned')).toBe(true);
      expect(isSubagentEvent('worker_status')).toBe(true);
      expect(isSubagentEvent('worker_done')).toBe(true);
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

// Design §8.2, ported from the web module this file's source was ported to.
// Byte-for-byte the same nine cases: the fold's adjacency rule and the summary
// line are the two things three clients have to agree on.
describe('clusterAdjacent', () => {
  it('clusters children whose start events are adjacent', () => {
    const events = [started('a'), started('b'), started('c')];
    const clusters = clusterAdjacent(groupSubagentEvents(events, true));
    expect(clusters.map((c) => c.map((g) => g.subagentId))).toEqual([['a', 'b', 'c']]);
  });

  it('clusters across the interleaved legacy mirrors and agent_spawned chrome', () => {
    const events = [
      workerSpawned('a'),
      { type: 'agent_spawned', name: 'reviewer' } as McAgentEvent,
      started('a'),
      workerSpawned('b'),
      { type: 'agent_spawned', name: 'reviewer' } as McAgentEvent,
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

describe('isSubagentEvent', () => {
  it('claims the canonical family AND the three D8 retired, so neither reaches the unknown-activity fallback', () => {
    for (const type of [
      'subagent_started',
      'subagent_progress',
      'subagent_finished',
      'worker_spawned',
      'worker_status',
      'worker_done',
    ]) {
      expect(isSubagentEvent(type)).toBe(true);
    }
  });

  it('does not claim ordinary transcript events', () => {
    for (const type of ['text_delta', 'tool_result', 'agent_spawned', 'response']) {
      expect(isSubagentEvent(type)).toBe(false);
    }
  });
});

describe('isTerminalSubagentStatus', () => {
  // The predicate this replaces knew only done/failed/cancelled, so an
  // `interrupted` or `max_turns` child read as still live.
  it('treats every finished outcome as terminal, including interrupted and max_turns', () => {
    for (const status of ['done', 'failed', 'cancelled', 'interrupted', 'max_turns'] as const) {
      expect(isTerminalSubagentStatus(status)).toBe(true);
    }
  });

  it('treats live states as non-terminal', () => {
    expect(isTerminalSubagentStatus('running')).toBe(false);
    expect(isTerminalSubagentStatus('waiting')).toBe(false);
  });
});

describe('rowStatusOf', () => {
  it('renames only waiting_input, and passes every other status through', () => {
    expect(rowStatusOf('waiting_input')).toBe('waiting');
    for (const status of [
      'running',
      'done',
      'failed',
      'cancelled',
      'interrupted',
      'max_turns',
    ] as const) {
      expect(rowStatusOf(status)).toBe(status);
    }
  });
});

describe('resolveSubagentStatus', () => {
  const waitingFold = groupSubagentEvents(
    [started('a'), progress('a', { status: 'waiting_input', question: 'Which branch?' })],
    true,
  )[0];
  const doneFold = groupSubagentEvents([started('a'), finished('a')], false)[0];

  it('prefers the list entry when there is one', () => {
    expect(resolveSubagentStatus(doneFold, listEntry({ status: 'running' }))).toBe('running');
  });

  it('falls back to the fold for a nested child the list does not carry', () => {
    // `listSubagents` returns DEPTH-0 children only, so a grandchild rendered
    // inside an expanded row has no entry and the fold is all there is.
    expect(resolveSubagentStatus(doneFold, undefined)).toBe('done');
    expect(resolveSubagentStatus(waitingFold, undefined)).toBe('waiting');
  });

  it('translates the wire vocabulary on the way through', () => {
    expect(resolveSubagentStatus(doneFold, listEntry({ status: 'waiting_input' }))).toBe('waiting');
  });
});

describe('resolveSubagentQuestion', () => {
  const waitingFold = groupSubagentEvents(
    [started('a'), progress('a', { status: 'waiting_input', question: 'Which branch?' })],
    true,
  )[0];

  it('keeps the question while the resolved status is live', () => {
    expect(resolveSubagentQuestion(waitingFold, undefined)).toBe('Which branch?');
    expect(resolveSubagentQuestion(waitingFold, listEntry({ status: 'waiting_input' }))).toBe(
      'Which branch?',
    );
  });

  it('drops a question the fold is still holding once the server says terminal', () => {
    // The row's own events cannot say so: outside a live parent turn no child
    // event reaches the parent at all, so a child stopped from the panel keeps
    // its `waiting` fold forever. Gating on the RESOLVED status is what stops
    // a dead child offering a reply box.
    expect(
      resolveSubagentQuestion(waitingFold, listEntry({ status: 'cancelled' })),
    ).toBeUndefined();
  });
});

describe('subagentElapsedMs', () => {
  const now = Date.parse('2026-09-04T00:02:00.000Z');

  it('measures a finished run from its own two timestamps', () => {
    expect(subagentElapsedMs(START_ISO, END_ISO, false, now)).toBe(72_000);
  });

  it('counts up from the start while the run is live', () => {
    expect(subagentElapsedMs(START_ISO, undefined, true, now)).toBe(120_000);
  });

  it('renders nothing for a terminal run with no endedAt', () => {
    // An end-of-stream `cancelled` and a legacy `worker_done` both arrive
    // terminal with no end timestamp. The run's duration is unknown; the row's
    // own age answers a different question and grows every time the
    // conversation is reopened.
    expect(subagentElapsedMs(START_ISO, undefined, false, now)).toBeNull();
  });

  it('renders nothing when there is no usable start timestamp', () => {
    expect(subagentElapsedMs('', undefined, true, now)).toBeNull();
    expect(subagentElapsedMs('not a date', undefined, true, now)).toBeNull();
  });

  it('clamps a backwards clock to zero rather than rendering a negative', () => {
    expect(subagentElapsedMs(END_ISO, START_ISO, false, now)).toBe(0);
  });
});

describe('summarizeSwarmStrip', () => {
  it('returns null when there are no sub-agent groups', () => {
    expect(summarizeSwarmStrip([text('hi')], true)).toBeNull();
  });

  it('returns null when every child is terminal', () => {
    expect(summarizeSwarmStrip([started('a'), finished('a')], true)).toBeNull();
  });

  it('summarizes mixed running / waiting / done children', () => {
    const summary = summarizeSwarmStrip(
      [
        started('a'),
        started('b'),
        progress('b', { status: 'waiting_input', question: 'Proceed?' }),
        started('c'),
        finished('c'),
      ],
      true,
    );
    expect(summary).toEqual({
      total: 3,
      running: 1,
      waiting: 1,
      workers: [
        { subagentId: 'a', type: 'code-reviewer', status: 'running' },
        { subagentId: 'b', type: 'code-reviewer', status: 'waiting' },
        { subagentId: 'c', type: 'code-reviewer', status: 'done' },
      ],
    });
  });

  it('ignores orphan terminals (finished work from a prior message)', () => {
    expect(summarizeSwarmStrip([finished('a')], true)).toBeNull();
  });

  it('still returns null once the stream ends (everything terminalizes)', () => {
    expect(summarizeSwarmStrip([started('a')], false)).toBeNull();
  });
});

/**
 * Byte-for-byte parity with `apps/web`'s `formatElapsed`/`formatToolCount` and
 * iOS's `SubagentFormat`, read from the one file all three consume. Mission
 * Control is the third client on this lock; the other two are
 * `apps/web/src/ui/blocks/rendering-parity.test.ts` and
 * `ios/DashTests/Features/RenderingParityTests.swift`.
 */
describe('rendering parity fixtures', () => {
  interface ElapsedCase {
    name: string;
    kind: 'elapsed';
    inputMs: number;
    expectedText: string;
  }
  interface ToolCountCase {
    name: string;
    kind: 'toolCount';
    inputCount: number;
    expectedText: string;
  }
  const fixture = JSON.parse(
    readFileSync(
      resolve(__dirname, '../../../../../../scripts/fixtures/rendering-fixtures.json'),
      'utf-8',
    ),
  ) as { cases: { kind: string }[] };

  const elapsedCases = fixture.cases.filter((c): c is ElapsedCase => c.kind === 'elapsed');
  const toolCountCases = fixture.cases.filter((c): c is ToolCountCase => c.kind === 'toolCount');

  it('loaded both case kinds (an empty filter would assert nothing)', () => {
    expect(elapsedCases.length).toBeGreaterThan(0);
    expect(toolCountCases.length).toBeGreaterThan(0);
  });

  it.each(elapsedCases)('elapsed: $name', (testCase) => {
    expect(formatElapsed(testCase.inputMs)).toBe(testCase.expectedText);
  });

  it.each(toolCountCases)('toolCount: $name', (testCase) => {
    expect(formatToolCount(testCase.inputCount)).toBe(testCase.expectedText);
  });
});

describe('SubagentGroup', () => {
  it('is the type the renderer keys rows by', () => {
    const group: SubagentGroup = groupSubagentEvents([started('a')], true)[0];
    expect(group.subagentId).toBe('a');
  });
});

/**
 * D4 — §8.2's parallel-group container, against streams a real gateway sent.
 *
 * Both files were captured verbatim by
 * `scripts/subagents-e2e/capture-fixtures.mjs`, and they disagree, which is
 * the finding. Two FOREGROUND `agent` calls put both children's `tool_result`s
 * after both `subagent_started`s and the container renders. Two BACKGROUND
 * calls return each child's "launched in the background" `tool_result`
 * IMMEDIATELY, so one lands between the anchors — and the container vanishes
 * while both children are still running, which is exactly the case §8.2
 * exists for. D4 was filed as structural; it is this race.
 */
describe('captured gateway streams — §8.2 parallel groups', () => {
  const eventsOf = (file: string): McAgentEvent[] => {
    const frames = readFileSync(
      resolve(__dirname, '../../../../../../contracts/mobile/v1/fixtures', file),
      'utf8',
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; id: string; event?: McAgentEvent });
    const first = frames[0].id;
    return frames
      .filter((f) => f.type === 'event' && f.id === first)
      .map((f) => f.event as McAgentEvent);
  };

  const containers = (file: string): string[] =>
    clusterAdjacent(groupSubagentEvents(eventsOf(file), false))
      .filter((cluster) => cluster.length > 1)
      .map(formatClusterSummary);

  it('renders one container for two foreground children in one turn', () => {
    expect(containers('subagent-parallel-frames.jsonl')).toEqual(['2 agents · 2 done']);
  });

  it('renders one container for two background children in one turn', () => {
    // RED before the fix: `[]`.
    expect(containers('subagent-background-pair-frames.jsonl')).toEqual([
      '2 agents · 1 running · 1 done',
    ]);
  });

  it('still splits a cluster when real content sits between two spawns', () => {
    const events = eventsOf('subagent-background-pair-frames.jsonl');
    const second = events
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => event.type === 'subagent_started')[1];
    const split = [...events];
    split.splice(second.index, 0, {
      type: 'text_delta',
      text: 'and now, separately',
    } as McAgentEvent);
    expect(clusterAdjacent(groupSubagentEvents(split, false)).filter((c) => c.length > 1)).toEqual(
      [],
    );
  });
});

describe('subagentReportSummary', () => {
  it('keeps a short single-line report intact', () => {
    expect(subagentReportSummary('Two findings, both minor.')).toBe('Two findings, both minor.');
  });

  it('takes the first line that carries words, stripping Markdown chrome', () => {
    expect(subagentReportSummary('\n\n## Findings\n\n| a | b |\n')).toBe('Findings');
  });

  it('clips a long line and marks the clip', () => {
    const summary = subagentReportSummary(`${'x'.repeat(400)}\ntail`);
    expect(summary).toHaveLength(120);
    expect(summary.endsWith('…')).toBe(true);
  });

  it('returns nothing for a report that is only whitespace and chrome', () => {
    expect(subagentReportSummary('\n\n---\n  \n')).toBe('');
  });
});
