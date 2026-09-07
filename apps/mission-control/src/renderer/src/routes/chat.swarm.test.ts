import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SubagentListEntry } from '@dash/mobile-contract';
import { describe, expect, it } from 'vitest';
import type { McAgentEvent } from '../../../shared/ipc.js';
import {
  type SubagentGroup,
  formatElapsed,
  formatToolCount,
  groupSubagentEvents,
  isSubagentEvent,
  isTerminalSubagentStatus,
  resolveSubagentQuestion,
  resolveSubagentStatus,
  rowStatusOf,
  subagentElapsedMs,
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

  it('does not let a stale worker_status question survive a modern running progress', () => {
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

  describe('legacy worker_* mirrors (removed in D8)', () => {
    it('folds worker_* and subagent_* for the same child into ONE group', () => {
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

describe('isSubagentEvent', () => {
  it('claims both event families so neither reaches the unknown-activity fallback', () => {
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
