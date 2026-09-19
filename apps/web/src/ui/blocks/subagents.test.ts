import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MobileAgentEvent } from '@dash/mobile-contract';
import {
  clusterAdjacent,
  formatClusterSummary,
  formatElapsed,
  formatToolCount,
  groupSubagentEvents,
  isSubagentEvent,
  isTerminalSubagentStatus,
  mergeSubagentEventLists,
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

  /**
   * D8 retired the `worker_*` mirrors. Nothing emits one, but a transcript
   * PERSISTED before D8 still contains them, and the policy is that the client
   * DROPS them: they anchor nothing, contribute nothing, and — because
   * `isSubagentEvent` still claims them — never reach the renderer's
   * unsupported-content fallback.
   */
  describe('a persisted PRE-D8 transcript', () => {
    it('renders one normal row from the canonical half alone', () => {
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

    it('creates NO row for a legacy-only child (nothing canonical ever arrived)', () => {
      const events = [
        workerSpawned('a'),
        workerStatus('a', { detail: 'digging' }),
        workerDone('a'),
      ];
      expect(groupSubagentEvents(events, false)).toEqual([]);
    });

    it('a retired mirror contributes no field, in either arrival order', () => {
      const forward = groupSubagentEvents(
        [started('a'), workerDone('a', { status: 'cancelled', report: 'Legacy report.' })],
        false,
      )[0];
      const reversed = groupSubagentEvents(
        [workerDone('a', { status: 'cancelled', report: 'Legacy report.' }), started('a')],
        false,
      )[0];
      for (const group of [forward, reversed]) {
        // No terminal event of the canonical family arrived, so end-of-stream
        // terminalization applies — the retired `cancelled` is NOT the source.
        expect(group.status).toBe('cancelled');
        expect(group.report).toBeUndefined();
        expect(group.type).toBe('code-reviewer');
      }
    });

    it('a retired worker_status leaves no question and no live status on the row', () => {
      const events = [
        started('a'),
        workerStatus('a', { status: 'waiting_input', question: 'Which branch?' }),
      ];
      const [group] = groupSubagentEvents(events, true);
      expect(group.status).toBe('running');
      expect(group.question).toBeUndefined();
      // The only detail left is the kickoff description fallback, never the
      // mirror's question.
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
 *
 * The `agent` tool's own start/result are chrome for adjacency because the
 * fold already renders that tool call AS the card.
 */
describe('captured gateway streams — §8.2 parallel groups', () => {
  const eventsOf = (file: string): MobileAgentEvent[] => {
    const path = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../../../../../contracts/mobile/v1/fixtures',
      file,
    );
    const frames = readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; id: string; event?: MobileAgentEvent });
    const first = frames[0].id;
    return frames
      .filter((f) => f.type === 'event' && f.id === first)
      .map((f) => f.event as MobileAgentEvent);
  };

  const containers = (file: string): string[] =>
    clusterAdjacent(groupSubagentEvents(eventsOf(file), false))
      .filter((cluster) => cluster.length > 1)
      .map(formatClusterSummary);

  it('renders one container for two foreground children in one turn', () => {
    expect(containers('subagent-parallel-frames.jsonl')).toEqual(['2 agents · 2 done']);
  });

  it('renders one container for two background children in one turn', () => {
    // RED before the fix: `[]`. Two `tool_result` events for the `agent` tool
    // sit between the anchors, `adjacentToPrevious` is false, and
    // `clusterAdjacent` yields two clusters of one.
    expect(containers('subagent-background-pair-frames.jsonl')).toEqual([
      '2 agents · 1 running · 1 done',
    ]);
  });

  it('still splits a cluster when real content sits between two spawns', () => {
    const events = eventsOf('subagent-background-pair-frames.jsonl');
    const anchors = events
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => event.type === 'subagent_started');
    expect(anchors).toHaveLength(2);
    const split = [...events];
    split.splice(anchors[1].index, 0, { type: 'text_delta', text: 'and now, separately' });
    expect(clusterAdjacent(groupSubagentEvents(split, false)).filter((c) => c.length > 1)).toEqual(
      [],
    );
  });
});

/**
 * D2 on web — every background child draws a SECOND card.
 *
 * The port of MC's `01eae2ed`, against the same captured stream.
 * `subagent-notification-frames.jsonl` is one real conversation: an assistant
 * turn that spawns a background `writer`, then the server-initiated
 * notification turn its completion wakes. Both messages name the same child,
 * and the fold is per MESSAGE on every client by construction, so it cannot
 * see that this child already has a card earlier in the conversation and
 * anchors one in each.
 */
describe('captured gateway streams — D2 duplicate cards', () => {
  const messageEventLists = (file: string): MobileAgentEvent[][] => {
    const path = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../../../../../contracts/mobile/v1/fixtures',
      file,
    );
    const frames = readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; id: string; event?: MobileAgentEvent });
    const byTurn = new Map<string, MobileAgentEvent[]>();
    for (const frame of frames) {
      if (frame.type !== 'event' || !frame.event) continue;
      const list = byTurn.get(frame.id) ?? [];
      list.push(frame.event);
      byTurn.set(frame.id, list);
    }
    return [...byTurn.values()];
  };

  const cardsPerMessage = (lists: readonly (MobileAgentEvent[] | null)[]): string[][] =>
    lists.map((list) => (list ? groupSubagentEvents(list, false).map((g) => g.subagentId) : []));

  it('the real stream anchors the same child in two messages', () => {
    const lists = messageEventLists('subagent-notification-frames.jsonl');
    expect(lists).toHaveLength(2);
    const cards = cardsPerMessage(lists);
    // The defect, stated as the fixture states it: two cards, one child.
    expect(cards[0]).toHaveLength(1);
    expect(cards[1]).toEqual(cards[0]);
  });

  it('merges the notification turn back into the message that anchored the child', () => {
    const lists = messageEventLists('subagent-notification-frames.jsonl');
    const merged = mergeSubagentEventLists(lists);
    const cards = cardsPerMessage(merged);
    expect(cards[0]).toHaveLength(1);
    expect(cards[1]).toEqual([]);
    // Nothing is lost: the surviving card carries the terminal the
    // notification turn delivered.
    const group = groupSubagentEvents(merged[0] as MobileAgentEvent[], false)[0];
    expect(group.status).toBe('done');
    expect(group.endedAt).toBeDefined();
    // Still anchored by its OWN start, not re-anchored by the moved terminal.
    expect(group.startedAt).not.toBe('');
    expect(group.background).toBe(true);
    expect(group.orphan).toBe(false);
  });

  it('leaves a child with no earlier anchor where it is', () => {
    // Crash-reconcile: only the terminal survives, in its own message. §31.4 /
    // §32.8.4 keep that card, because nothing else will ever draw it.
    const lists = messageEventLists('subagent-notification-frames.jsonl');
    expect(cardsPerMessage(mergeSubagentEventLists([lists[1]]))[0]).toHaveLength(1);
  });

  it('does not perturb §8.2 adjacency in the message the events land in', () => {
    // Every folded event is chrome, so a moved terminal cannot split a
    // parallel cluster in the message it is appended to.
    const parallel = messageEventLists('subagent-parallel-frames.jsonl');
    const merged = mergeSubagentEventLists([...parallel, null]);
    const clusters = clusterAdjacent(
      groupSubagentEvents(merged[0] as MobileAgentEvent[], false),
    ).filter((c) => c.length > 1);
    expect(clusters.map(formatClusterSummary)).toEqual(['2 agents · 2 done']);
  });
});
