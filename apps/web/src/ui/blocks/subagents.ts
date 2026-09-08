/**
 * Pure fold logic for sub-agent events in the chat transcript — the web port
 * of Mission Control's `apps/mission-control/src/renderer/src/routes/chat.swarm.ts`
 * (`groupWorkerEvents` / `deriveWorkerStatus` / `isTerminalStatus` /
 * `latestWorkerDetail` / `summarizeSwarmStrip`), extended for the Phase B/C
 * `subagent_*` events. Design doc §8.1 (collapsed row) and §8.2 (parallel
 * group) are the visual spec; this module is the model those components read.
 *
 * Like `tool-presentation.ts` next door, this file is deliberately JSX-free
 * and framework-free so it can be unit-tested without a DOM. The row, group
 * and nested-transcript components live elsewhere (tasks D2/D3).
 *
 * Two things ported verbatim from MC because they are load-bearing and
 * already proven:
 *
 * 1. **Orphan handling.** Crash-reconcile can split one child across two
 *    persisted messages: the start lands in message A and the terminal event
 *    in message B. In message B that terminal is "orphaned" (no start in the
 *    same event list); it still yields a group, flagged `orphan`, anchored at
 *    the terminal's own position, so the renderer can draw a compact
 *    standalone "sub-agent finished" row.
 * 2. **End-of-stream terminalization.** When the stream has ended
 *    (`isStreaming === false`) a group that never reached a terminal event is
 *    reported as `cancelled` — the run is over and this child simply never
 *    reported back.
 *
 * ONE family. D8 retired the legacy `worker_*` mirrors: nothing emits one, and
 * `subagent_started` is the only anchor. A transcript PERSISTED before D8
 * still contains them, and the recorded policy is that the CLIENT drops them
 * (the gateway does not rewrite on replay). The mirrors were never TWINNED in
 * the log — a `worker_done` written on the consumer-gone cancel path has no
 * `subagent_finished` beside it — so dropping them loses that one cancel
 * report (pinned: `a retired mirror contributes no field…`, TEST_PLAN §32.8
 * step 4). Dropping is still the choice because rewriting on replay would put
 * a synthesised event into every old conversation's log for a report nobody
 * had asked for.
 * They stay in {@link isSubagentEvent} so the transcript renderer keeps
 * skipping them rather than drawing its unsupported-content fallback three
 * times per child.
 */

import type { MobileAgentEvent, SubagentStatus as WireSubagentStatus } from '@dash/mobile-contract';

/** Coalesced lifecycle state for one child, as the collapsed row renders it. */
export type SubagentStatus =
  | 'running'
  | 'waiting'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'max_turns';

/**
 * Everything the collapsed row (§8.1) needs for one child, folded from every
 * event in a single assistant message that names it.
 */
export interface SubagentGroup {
  /** The child's conversation id — also its legacy `workerId`. */
  subagentId: string;
  /** Optional human name from the `agent` tool call. */
  name?: string;
  /** `subagentType` (or, for a legacy-only child, its `role`). */
  type: string;
  /** One-line description (or, for a legacy-only child, its `brief`). */
  description: string;
  /** Coalesced status, with end-of-stream terminalization applied. */
  status: SubagentStatus;
  /** True when the child was spawned to outlive the turn. */
  background: boolean;
  /** 1 for a child of a user conversation. */
  depth: number;
  /**
   * ISO start timestamp; empty string until `subagent_started` arrives (an
   * orphan terminal from a crash-split message has none).
   */
  startedAt: string;
  /** ISO end timestamp; present only once `subagent_finished` has arrived. */
  endedAt?: string;
  /** Tool calls the child has made, from the newest event that reports one. */
  toolCallCount: number;
  /** The child's final report, once terminal. */
  report?: string;
  /**
   * The pending question, present only while the row is NOT terminal — §8.1
   * hangs the inline reply affordance off this field, so a finished,
   * cancelled or end-of-stream-terminalized child never carries one. The
   * question text survives in `detail` as the last thing the child said.
   */
  question?: string;
  /** One-line detail for the collapsed row (MC's `latestWorkerDetail`). */
  detail?: string;
  /**
   * Index into the source `events` array at which this group's row renders:
   * the first start event's position, or the orphan terminal's position.
   */
  anchorIndex: number;
  /** True when no start event for this child appeared in THIS message. */
  orphan: boolean;
  /**
   * True when this group's start event is "adjacent" to the previous group's
   * in the same message — nothing but sub-agent chrome sits between them —
   * which is what §8.2 means by a parallel group. Computed here because it
   * needs the source event list; `clusterAdjacent` only reads it, so it must
   * be given the unfiltered, in-order output of `groupSubagentEvents`.
   */
  adjacentToPrevious: boolean;
}

/** Event types this module folds into a row. */
const FOLDED_EVENT_TYPES = new Set(['subagent_started', 'subagent_progress', 'subagent_finished']);

/**
 * The retired `worker_*` mirrors (D8). They fold into NOTHING, but they are
 * still sub-agent events as far as the transcript renderer is concerned: a
 * persisted pre-D8 message contains three of them per child, and letting them
 * reach the renderer's unsupported-content fallback would redecorate every old
 * conversation with rows the user never had.
 */
const RETIRED_EVENT_TYPES = new Set(['worker_spawned', 'worker_status', 'worker_done']);

/**
 * Event types that render nothing of their own between two sub-agent rows.
 * `agent_spawned` is the coordinator's name-only announcement, pushed just
 * before a child's `subagent_started`; treating it as chrome is what lets
 * back-to-back spawns still read as one parallel group.
 */
const CHROME_EVENT_TYPES = new Set([
  ...FOLDED_EVENT_TYPES,
  ...RETIRED_EVENT_TYPES,
  'agent_spawned',
]);

/**
 * True for an event type the transcript renderer must NOT draw itself: the
 * three this module folds into a row, plus the three D8 retired, which a
 * persisted pre-D8 message still carries and which must not fall through to
 * the renderer's "unsupported content" fallback.
 */
export function isSubagentEvent(type: string): boolean {
  return FOLDED_EVENT_TYPES.has(type) || RETIRED_EVENT_TYPES.has(type);
}

const TERMINAL_STATUSES = new Set<SubagentStatus>([
  'done',
  'failed',
  'cancelled',
  'interrupted',
  'max_turns',
]);

/**
 * True when the child has finished, whatever the outcome. All five terminal
 * outcomes count: MC's `isTerminalStatus` predates `interrupted` / `max_turns`
 * reaching `worker_done.status`, and §8.1 gives all five a finished glyph.
 */
export function isTerminalSubagentStatus(status: SubagentStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/**
 * The wire's status (`SubagentInfo.status`, `SubagentListEntry.status`) as
 * this module's row model names it.
 *
 * The two vocabularies are the same set with one rename — the wire's
 * `waiting_input` is `waiting` here — so this is the whole translation, and
 * it exists so that anything reading a child from REST (the tasks panel,
 * §8.4) shares ONE terminal predicate and one status vocabulary with the rows
 * folded out of the transcript. A second `status === 'done' || …` list
 * somewhere else is how MC ended up with an `isTerminalStatus` that had never
 * heard of `interrupted` or `max_turns`.
 */
export function rowStatusOf(status: WireSubagentStatus): SubagentStatus {
  return status === 'waiting_input' ? 'waiting' : status;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function terminalStatus(value: unknown): SubagentStatus | undefined {
  return typeof value === 'string' && TERMINAL_STATUSES.has(value as SubagentStatus)
    ? (value as SubagentStatus)
    : undefined;
}

/** The child id an event names, or undefined when it is not a folded event. */
function subagentIdOf(event: MobileAgentEvent): string | undefined {
  if (!FOLDED_EVENT_TYPES.has(event.type)) return undefined;
  return str(event.subagentId) ?? str(event.workerId);
}

/**
 * One child's accumulated row. Single-family since D8 — the per-family slots
 * (`modernX` / `legacyX`) and the whole-unit progress resolution they needed
 * went with the `worker_*` mirrors.
 */
interface Draft {
  subagentId: string;
  anchorIndex: number;
  hasStart: boolean;
  orphan: boolean;
  name?: string;
  type?: string;
  description?: string;
  background?: boolean;
  depth?: number;
  startedAt?: string;
  endedAt?: string;
  terminal?: SubagentStatus;
  report?: string;
  live?: 'running' | 'waiting';
  detail?: string;
  question?: string;
  progressToolCallCount?: number;
  finishedToolCallCount?: number;
}

/**
 * Fold every `subagent_*` event in one assistant message's event list into one
 * group per child, in anchor order. A retired `worker_*` mirror is skipped
 * outright, so a persisted pre-D8 message folds to exactly the rows its
 * canonical half describes.
 *
 * `isStreaming` is the parent turn's liveness: when false, a child with no
 * terminal event is reported `cancelled` (MC's `deriveWorkerStatus`).
 */
export function groupSubagentEvents(
  events: readonly MobileAgentEvent[],
  isStreaming: boolean,
): SubagentGroup[] {
  const drafts = new Map<string, Draft>();

  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (RETIRED_EVENT_TYPES.has(event.type)) continue;
    const id = subagentIdOf(event);
    if (!id) continue;

    let draft = drafts.get(id);
    if (!draft) {
      // Provisionally an orphan until (and unless) a start event shows up.
      draft = {
        subagentId: id,
        anchorIndex: i,
        hasStart: false,
        orphan: true,
      };
      drafts.set(id, draft);
    }

    const isStart = event.type === 'subagent_started';
    if (isStart && !draft.hasStart) {
      // `subagent_started` is the ONLY anchor since D8.
      draft.anchorIndex = i;
      draft.hasStart = true;
      draft.orphan = false;
    }

    switch (event.type) {
      case 'subagent_started': {
        draft.name = str(event.name) ?? draft.name;
        draft.type = str(event.subagentType) ?? draft.type;
        draft.description = str(event.description) ?? draft.description;
        if (typeof event.background === 'boolean') draft.background = event.background;
        draft.depth = num(event.depth) ?? draft.depth;
        draft.startedAt = str(event.startedAt) ?? draft.startedAt;
        break;
      }
      case 'subagent_progress': {
        draft.live = event.status === 'waiting_input' ? 'waiting' : 'running';
        // Resolved as a UNIT with `live`: a running progress event deliberately
        // CLEARS the question, so `question` is assigned, never merged.
        draft.question = str(event.question);
        // Sticky, like MC's `latestWorkerDetail`, which scans BACKWARDS for the
        // newest event that actually carries something: a later progress event
        // with no detail must not blank the line the row is already showing.
        draft.detail = str(event.question) ?? str(event.detail) ?? draft.detail;
        draft.progressToolCallCount = num(event.toolCallCount) ?? draft.progressToolCallCount;
        break;
      }
      case 'subagent_finished': {
        draft.name = str(event.name) ?? draft.name;
        draft.type = str(event.subagentType) ?? draft.type;
        draft.description = str(event.description) ?? draft.description;
        draft.terminal = terminalStatus(event.status) ?? 'done';
        draft.report = str(event.report);
        draft.finishedToolCallCount = num(event.toolCallCount) ?? draft.finishedToolCallCount;
        draft.startedAt = str(event.startedAt) ?? draft.startedAt;
        draft.endedAt = str(event.endedAt) ?? draft.endedAt;
        break;
      }
    }
  }

  const ordered = [...drafts.values()].sort((a, b) => a.anchorIndex - b.anchorIndex);

  return ordered.map((draft, index) => {
    const description = draft.description ?? '';
    const terminal = draft.terminal;
    const live = draft.live;
    const question = draft.question;
    const latestDetail = draft.detail;
    const background = draft.background ?? false;
    // End-of-stream terminalization (MC's `deriveWorkerStatus`), with one
    // exemption MC never needed: a `background: true` child is spawned
    // precisely to OUTLIVE the turn that spawned it (design §6), so the
    // parent's message ending says nothing about whether it is still working.
    // Reporting `cancelled` there would draw a healthy agent as dead in every
    // finished message that ever spawned one. Only a real terminal event ends
    // a background child.
    const status: SubagentStatus =
      terminal ?? (isStreaming || background ? (live ?? 'running') : 'cancelled');
    const previous = ordered[index - 1];

    const group: SubagentGroup = {
      subagentId: draft.subagentId,
      type: draft.type ?? '',
      description,
      status,
      background,
      depth: draft.depth ?? 1,
      startedAt: draft.startedAt ?? '',
      toolCallCount: draft.finishedToolCallCount ?? draft.progressToolCallCount ?? 0,
      anchorIndex: draft.anchorIndex,
      orphan: draft.orphan,
      adjacentToPrevious:
        previous !== undefined &&
        !previous.orphan &&
        !draft.orphan &&
        isOnlyChromeBetween(events, previous.anchorIndex, draft.anchorIndex),
    };

    const name = draft.name;
    if (name !== undefined) group.name = name;
    const endedAt = draft.endedAt;
    if (endedAt !== undefined) group.endedAt = endedAt;
    const report = draft.report;
    if (report !== undefined) group.report = report;
    // Gated on the RESOLVED status, not just on the presence of a terminal
    // event: end-of-stream terminalization reaches `cancelled` with no
    // terminal event at all, and a dead child must never carry a pending
    // question — §8.1 hangs the inline reply affordance off this field.
    if (question !== undefined && !isTerminalSubagentStatus(status)) group.question = question;
    // MC's `latestWorkerDetail`: newest question, else newest detail, else the
    // kickoff description.
    const detail = latestDetail ?? (description || undefined);
    if (detail !== undefined) group.detail = detail;

    return group;
  });
}

/** True when every event strictly between `from` and `to` is sub-agent chrome. */
function isOnlyChromeBetween(
  events: readonly MobileAgentEvent[],
  from: number,
  to: number,
): boolean {
  for (let i = from + 1; i < to; i++) {
    if (!CHROME_EVENT_TYPES.has(events[i].type)) return false;
  }
  return true;
}

/**
 * Split groups into parallel clusters (§8.2): a run of children whose start
 * events are adjacent in the message renders inside one group container.
 *
 * Expects the in-order, unfiltered output of `groupSubagentEvents` — the
 * adjacency it splits on was computed there against the source event list.
 * Orphan terminals never join a cluster: they are finished children from a
 * previous message, not a live fan-out.
 */
export function clusterAdjacent(groups: readonly SubagentGroup[]): SubagentGroup[][] {
  const clusters: SubagentGroup[][] = [];
  for (const group of groups) {
    const current = clusters[clusters.length - 1];
    if (current && group.adjacentToPrevious) current.push(group);
    else clusters.push([group]);
  }
  return clusters;
}

const STATUS_WORDS: Record<SubagentStatus, string> = {
  running: 'running',
  waiting: 'waiting',
  done: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
  interrupted: 'interrupted',
  max_turns: 'max turns',
};

// Fixed order so the summary line reads the same way every render, rather
// than following whichever status happened to be seen first.
const STATUS_ORDER: SubagentStatus[] = [
  'running',
  'waiting',
  'done',
  'failed',
  'cancelled',
  'interrupted',
  'max_turns',
];

/**
 * The parallel group's summary line (§8.2), e.g. `3 agents · 2 running · 1 done`.
 * Empty buckets are omitted.
 */
export function formatClusterSummary(groups: readonly SubagentGroup[]): string {
  const counts = new Map<SubagentStatus, number>();
  for (const group of groups) counts.set(group.status, (counts.get(group.status) ?? 0) + 1);

  const parts = [`${groups.length} ${groups.length === 1 ? 'agent' : 'agents'}`];
  for (const status of STATUS_ORDER) {
    const count = counts.get(status);
    if (count) parts.push(`${count} ${STATUS_WORDS[status]}`);
  }
  return parts.join(' · ');
}

/**
 * Elapsed time for the collapsed row's right-aligned meta (§8.1): `45s`,
 * `1m 12s`, `2h 03m`. Seconds are floored (never rounded up into the next
 * unit) and the trailing unit is zero-padded to two digits once a larger unit
 * is shown. Byte-identical to iOS's `SubagentFormat.elapsed(_:)` — both are
 * asserted against `scripts/fixtures/rendering-fixtures.json`.
 */
export function formatElapsed(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  if (total < 60) return `${total}s`;

  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${String(total % 60).padStart(2, '0')}s`;

  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/**
 * Tool-call count for the collapsed row's meta (§8.1): `1 tool use`,
 * `12 tool uses`. Byte-identical to iOS's `SubagentFormat.toolCount(_:)`.
 */
export function formatToolCount(n: number): string {
  return `${n} tool ${n === 1 ? 'use' : 'uses'}`;
}
