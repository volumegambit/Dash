/**
 * Pure fold logic for sub-agent events in the chat transcript.
 *
 * This module used to fold only the legacy, run-scoped `worker_*` family into
 * one card per worker. It now folds the canonical `subagent_*` family
 * (sub-agents design §8.1) as well, and both families for the same child land
 * on ONE card. It is the RE-PORT of the web module that was itself ported from
 * here (`apps/web/src/ui/blocks/subagents.ts`, task D1): the fold originated in
 * Mission Control, gained the second event family and five defect fixes on the
 * web side, and comes home with them.
 *
 * Three named divergences were found when D1 diffed the two, and this file
 * settles each in the web port's favour:
 *
 * 1. **`isTerminalSubagentStatus` covers all five terminal outcomes.** The
 *    predicate this replaces knew only `done`/`failed`/`cancelled`, so an
 *    `interrupted` or `max_turns` child read as still live everywhere the
 *    predicate was consulted. Since D8 all five reach every client
 *    unflattened, because the flatten went with the mirrors.
 * 2. **`subagent_started` is the only anchor.** D8 retired the `worker_*`
 *    mirrors. A transcript PERSISTED before D8 still contains them, and the
 *    recorded policy is that the CLIENT drops them (the gateway does not
 *    rewrite on replay) — they stay in {@link isSubagentEvent} only so the
 *    renderer keeps skipping them.
 * 3. **Groups are ordered by `anchorIndex`**, not by first-seen insertion —
 *    the two differ once a child's first event is a terminal orphan.
 *
 * Two things kept verbatim from the original because they are load-bearing and
 * already proven here:
 *
 * - **Orphan handling.** Crash-reconcile can split one child across two
 *   persisted messages: the start lands in message A and the terminal event in
 *   message B. In message B that terminal is "orphaned" (no start in the same
 *   event list); it still yields a group, flagged `orphan`, anchored at the
 *   terminal's own position, so the renderer can draw a compact standalone
 *   "sub-agent finished" card.
 * - **End-of-stream terminalization.** When the stream has ended
 *   (`isStreaming === false`) a group that never reached a terminal event is
 *   reported `cancelled` — the run is over and this child never reported back.
 *   With ONE exemption added on the web side: a `background: true` child is
 *   spawned precisely to OUTLIVE the turn that spawned it (design §6), so the
 *   parent's message ending says nothing about whether it is still working.
 *
 * ONE family since D8. The gateway retired the legacy `worker_*` mirrors, so
 * `subagent_started` is the only anchor and every field has ONE source —
 * including `model` and `usage`, which used to be plain last-writer-wins slots
 * written by both families. A transcript PERSISTED before D8 still contains
 * the mirrors, and the recorded policy is that the CLIENT drops them. They were
 * never TWINNED in the log — a `worker_done` from the consumer-gone cancel path
 * has no `subagent_finished` beside it — so dropping loses that one cancel
 * report (pinned; TEST_PLAN §32.8 step 4). Dropping is still the choice: a
 * rewrite on replay would synthesise an event into every old log.
 * They stay in {@link isSubagentEvent} so the renderer keeps skipping them.
 *
 * All functions here are framework-free pure functions so they can be
 * unit-tested under the app's vitest config without a DOM. The presentational
 * components live in `chat.tsx`.
 *
 * §8.2's parallel-group container (`clusterAdjacent` / `formatClusterSummary`
 * / `adjacentToPrevious`) is HERE. It was left out of the first port on the
 * reading that §8.4's Mission Control bullet asks only for the panel and the
 * nested transcript; that reading was wrong. §8.1 is titled "Collapsed row
 * (all clients)" and §8.2 and §8.3 continue its scope with no client
 * qualifier — §8.4 is the only per-client subsection, and it governs the tasks
 * panel, which is not what §8.2 is about. Web and iOS both shipped it; this
 * fold is where the whole module started, so the container comes home too.
 *
 * The pinned strip (`summarizeSwarmStrip`) is Mission Control's own and has no
 * web twin. It stays separate from `formatClusterSummary` on purpose: the
 * strip summarises a LIVE turn across the whole message and deliberately shows
 * only the running and waiting buckets, while §8.2's line counts every status
 * in one parallel group.
 */

import type {
  SubagentListEntry,
  SubagentStatus as WireSubagentStatus,
} from '@dash/mobile-contract';
import type { MobileAgentEvent } from '@dash/mobile-contract';
import type { McAgentEvent } from '../../../shared/ipc.js';

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
  /** The child's conversation id. */
  subagentId: string;
  /** Optional human name from the `agent` tool call. */
  name?: string;
  /** `subagentType`. */
  type: string;
  /** One-line description. */
  description: string;
  /** Coalesced status, with end-of-stream terminalization applied. */
  status: SubagentStatus;
  /** True when the child was spawned to outlive the turn. */
  background: boolean;
  /** 1 for a child of a user conversation. */
  depth: number;
  /** ISO start timestamp; empty string until `subagent_started` arrives. */
  startedAt: string;
  /** ISO end timestamp; present only once `subagent_finished` has arrived. */
  endedAt?: string;
  /** Tool calls the child has made, from the newest event that reports one. */
  toolCallCount: number;
  /** Model id, when a start event carried one. */
  model?: string;
  /** The child's final report, once terminal. */
  report?: string;
  /** Token usage from the terminal event, when it carried any. */
  usage?: { inputTokens: number; outputTokens: number };
  /**
   * The pending question, present only while the FOLD's own status is not
   * terminal. Read it through {@link resolveSubagentQuestion}, never directly:
   * the server can know the child is finished when this message's events
   * cannot.
   */
  question?: string;
  /** One-line detail for the collapsed row (the old `latestWorkerDetail`). */
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
   * be given the unfiltered, in-order output of {@link groupSubagentEvents}.
   */
  adjacentToPrevious: boolean;
}

/** Event types this module folds into a card. */
const FOLDED_EVENT_TYPES = new Set<string>([
  'subagent_started',
  'subagent_progress',
  'subagent_finished',
]);

/**
 * The retired `worker_*` mirrors (D8). They fold into NOTHING, but a persisted
 * pre-D8 message carries three of them per child, and letting them reach the
 * renderer's "Activity from a newer Dash version" fallback would redecorate
 * every old conversation with rows the user never had.
 */
const RETIRED_EVENT_TYPES = new Set<string>(['worker_spawned', 'worker_status', 'worker_done']);

/**
 * Event types that render nothing of their own between two sub-agent cards.
 * `agent_spawned` is the coordinator's name-only announcement, pushed just
 * before a child's `subagent_started`; treating it as chrome is what lets
 * back-to-back spawns still read as one parallel group.
 */
const CHROME_EVENT_TYPES = new Set<string>([
  ...FOLDED_EVENT_TYPES,
  ...RETIRED_EVENT_TYPES,
  'agent_spawned',
]);

/** The tool whose call IS a child. Its own rows are the card, not content. */
const SPAWNING_TOOL = 'agent';

/**
 * True for an event that renders nothing of its own between two sub-agent
 * cards.
 *
 * The `agent` tool's own `tool_use_start` / `tool_result` count, and that is
 * D4: a BACKGROUND spawn's tool result comes back immediately ("launched in
 * the background"), so with two background children in one turn one child's
 * result lands between the two `subagent_started` anchors and splits what is
 * unambiguously a parallel group — both children still running — while two
 * FOREGROUND children in the same shape cluster fine, because their results
 * arrive after both starts. `subagent-background-pair-frames.jsonl` and
 * `subagent-parallel-frames.jsonl` are the two real streams.
 *
 * Only the SPAWNING tool is chrome. Any other tool call between two spawns is
 * real content and still splits the cluster: this tool call is already
 * rendered — as the card.
 */
function isChromeEvent(event: McAgentEvent): boolean {
  if (CHROME_EVENT_TYPES.has(event.type)) return true;
  return (
    (event.type === 'tool_use_start' || event.type === 'tool_result') &&
    (event as { name?: unknown }).name === SPAWNING_TOOL
  );
}

/**
 * True for an event type the transcript renderer must NOT draw itself: the
 * three this module folds into a card, plus the three D8 retired, which a
 * persisted pre-D8 message still carries and which must not fall through to
 * its "Activity from a newer Dash version" fallback.
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
 * True when the child has finished, whatever the outcome. All FIVE terminal
 * outcomes count — see divergence 1 in the module comment.
 */
export function isTerminalSubagentStatus(status: SubagentStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/**
 * The wire's status (`SubagentListEntry.status`) as this module's row model
 * names it. The two vocabularies are the same set with one rename, so this is
 * the whole translation, and it exists so that anything reading a child from
 * REST shares ONE terminal predicate and one status vocabulary with the cards
 * folded out of the transcript.
 */
export function rowStatusOf(status: WireSubagentStatus): SubagentStatus {
  return status === 'waiting_input' ? 'waiting' : status;
}

/**
 * The status a row RENDERS: the server's when this child has a list entry,
 * this message's fold when it does not.
 *
 * REST wins because the fold can only see events that reached the parent's
 * stream, and outside a live parent turn no child event reaches the parent at
 * all (`coordinator.ts` only fans out to a live turn). A child stopped from the
 * panel, or resumed and finished later, keeps its pre-event status in the fold
 * forever. It is also why a resume must trigger a list re-read: without one,
 * every surface holds the child's pre-resume status for the whole new run.
 *
 * The fold cannot simply be dropped, though: `listSubagents` returns DEPTH-0
 * children only, so a grandchild rendered inside an expanded row has no entry
 * and folds. The visible consequence, recorded rather than hidden: inside one
 * expanded card the header can read the server while the rows beneath it read
 * the fold, so a `done` child may sit above a grandchild that says `Running`
 * forever. That is honest — a finished parent may genuinely have had children
 * whose fate this client cannot learn.
 *
 * Cost: while a live turn is streaming, a `subagent_finished` that has not yet
 * been followed by a list read leaves the row one round trip behind. Bounded,
 * and the read is already in flight when it happens.
 */
export function resolveSubagentStatus(
  group: Pick<SubagentGroup, 'status'>,
  entry: Pick<SubagentListEntry, 'status'> | undefined,
): SubagentStatus {
  return entry ? rowStatusOf(entry.status) : group.status;
}

/**
 * The question a row renders an inline reply for — gated on the RESOLVED
 * status, not on the fold's own.
 *
 * A dead child must never offer a reply box, and the fold alone cannot tell:
 * stop a waiting child from the panel and no event reaches this message, so its
 * `question` survives. Three separate paths have now broken the "no question on
 * a terminal row" rule, which is why the gate lives here rather than at each
 * render site.
 */
export function resolveSubagentQuestion(
  group: Pick<SubagentGroup, 'status' | 'question'>,
  entry: Pick<SubagentListEntry, 'status'> | undefined,
): string | undefined {
  if (isTerminalSubagentStatus(resolveSubagentStatus(group, entry))) return undefined;
  return group.question;
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

/**
 * The child id an event names, or undefined when it is not a folded event.
 *
 * Exported for the store's live status map, which reads events straight off
 * the wire: both families name the same string (a child's conversation id IS
 * its worker id), and one reader of that rule is better than two. Typed on
 * the WIRE shape (`MobileAgentEvent`, an open record) rather than the folded
 * one so both callers fit; every field it reads goes through `str`, which
 * already treats them as unknown.
 */
export function subagentIdOf(event: MobileAgentEvent): string | undefined {
  switch (event.type) {
    case 'subagent_started':
    case 'subagent_progress':
    case 'subagent_finished':
      return str(event.subagentId);
    default:
      return undefined;
  }
}

/**
 * One child's accumulated card. Single-family since D8 — the per-family slots
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
  model?: string;
  usage?: { inputTokens: number; outputTokens: number };
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
 * outright, so a persisted pre-D8 message folds to exactly the cards its
 * canonical half describes.
 *
 * `isStreaming` is the parent turn's liveness: when false, a child with no
 * terminal event is reported `cancelled` (the old `deriveWorkerStatus`).
 */
export function groupSubagentEvents(
  events: readonly McAgentEvent[],
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
      // `subagent_started` is the ONLY anchor since D8 (divergence 2).
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
        draft.model = str(event.model) ?? draft.model;
        break;
      }
      case 'subagent_progress': {
        draft.live = event.status === 'waiting_input' ? 'waiting' : 'running';
        // Resolved as a UNIT with `live`: a running progress event deliberately
        // CLEARS the question, so `question` is assigned, never merged.
        draft.question = str(event.question);
        // Sticky, like the old `latestWorkerDetail`, which scanned BACKWARDS
        // for the newest event that actually carried something: a later
        // progress event with no detail must not blank the line the row shows.
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
        draft.usage = event.usage ?? draft.usage;
        break;
      }
      default:
        break;
    }
  }

  // By anchorIndex, not by insertion order (divergence 3).
  const ordered = [...drafts.values()].sort((a, b) => a.anchorIndex - b.anchorIndex);

  return ordered.map((draft, index) => {
    const description = draft.description ?? '';
    const terminal = draft.terminal;
    const live = draft.live;
    const question = draft.question;
    const latestDetail = draft.detail;
    const background = draft.background ?? false;
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
    const model = draft.model;
    if (model !== undefined) group.model = model;
    const usage = draft.usage;
    if (usage !== undefined) group.usage = usage;
    const report = draft.report;
    if (report !== undefined) group.report = report;
    // Gated on the RESOLVED status, not just on the presence of a terminal
    // event: end-of-stream terminalization reaches `cancelled` with no terminal
    // event at all, and a dead child must never carry a pending question.
    if (question !== undefined && !isTerminalSubagentStatus(status)) group.question = question;
    const detail = latestDetail ?? (description || undefined);
    if (detail !== undefined) group.detail = detail;

    return group;
  });
}

/** True when every event strictly between `from` and `to` is sub-agent chrome. */
function isOnlyChromeBetween(events: readonly McAgentEvent[], from: number, to: number): boolean {
  for (let i = from + 1; i < to; i++) {
    if (!isChromeEvent(events[i])) return false;
  }
  return true;
}

/**
 * Split groups into parallel clusters (§8.2): a run of children whose start
 * events are adjacent in the message renders inside one group container.
 *
 * Expects the in-order, unfiltered output of {@link groupSubagentEvents} — the
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
 * Empty buckets are omitted. Byte-identical to web's `formatClusterSummary`,
 * which is the spec's own example.
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
 * Elapsed milliseconds for the collapsed row's right-aligned meta (§8.1:
 * "elapsed ticks live while running; frozen on finish"), or `null` when the row
 * must render no elapsed segment at all.
 *
 * Derived from the two ISO timestamps the fold carries, NEVER from
 * `subagent_progress.elapsedMs`: a row has to keep counting between progress
 * events, and that field is discarded by the fold.
 *
 * `running` decides whether the clock is live, NOT the presence of `endedAt`.
 * Plenty of finished children have no end timestamp — only `subagent_finished`
 * carries one, so an end-of-stream `cancelled` child arrives terminal without
 * it.
 *
 * A terminal run with no `endedAt` reports `null`, not its own age: the run's
 * duration is genuinely unknown, and `now - startedAt` answers a different
 * question. Reopen the conversation three hours later and a child that ran for
 * ten seconds would render `3h 00m`. `null` — not `0`, and not an empty
 * separator — is also the answer when there is no usable `startedAt` at all,
 * which is what an orphan terminal (a crash-split message whose start landed
 * elsewhere) folds to.
 */
/**
 * Fold every message's sub-agent events back onto the message that ANCHORED
 * each child (D2).
 *
 * The fold is message-scoped, and it must be: a card is anchored by the
 * `subagent_started` in its own message. But a conversation is not. A
 * background child's completion wakes the conversation with a server-initiated
 * notification turn that REPLAYS its `subagent_finished`, and the rule that an
 * orphan terminal still anchors its own card (§31.4, §32.8.4) — correct in
 * isolation, and asserted on purpose by `subagents:e2e` — then draws a second
 * card for a child that already has one. `subagent-notification-frames.jsonl`
 * is exactly that, captured: two messages, one child, two cards.
 *
 * A merge and not a suppression, because the two copies DISAGREE and the later
 * one is better: X1 saw `ls src dir` read `0 tool uses` in message 5 and
 * `1 tool use · 3s` in message 7. Dropping the notification's card would throw
 * the terminal away and leave the first card `running` for ever, since a
 * background child is exempt from end-of-stream terminalization by design.
 *
 * A child with no EARLIER anchor is left exactly where it is — that is the
 * crash-reconcile case §31.4 exists for, where the orphan terminal is the only
 * card anyone will ever draw.
 *
 * Takes and returns one entry per message, `null` for a non-assistant one, so
 * indices line up with the transcript and the caller needs no bookkeeping.
 */
export function mergeSubagentEventLists(
  lists: readonly (readonly McAgentEvent[] | null)[],
): (McAgentEvent[] | null)[] {
  const anchorOf = new Map<string, number>();
  lists.forEach((list, index) => {
    if (!list) return;
    for (const event of list) {
      if (event.type !== 'subagent_started') continue;
      const id = subagentIdOf(event);
      if (id !== undefined && !anchorOf.has(id)) anchorOf.set(id, index);
    }
  });

  const out: (McAgentEvent[] | null)[] = lists.map((list) => (list ? [] : null));
  lists.forEach((list, index) => {
    if (!list) return;
    for (const event of list) {
      const id = subagentIdOf(event);
      const anchor = id === undefined ? undefined : anchorOf.get(id);
      // Appended rather than spliced into position: the fold upserts by id and
      // guards the anchor with `hasStart`, so a later terminal updates the
      // card's fields without moving its anchor. Every folded event is chrome,
      // so it cannot perturb §8.2 adjacency in the message it lands in either.
      const target = anchor !== undefined && anchor !== index ? anchor : index;
      (out[target] as McAgentEvent[]).push(event);
    }
  });
  return out;
}

/**
 * The collapsed row's one line of report (§8.1, §32.4.2).
 *
 * D7: the panel rendered `entry.report` whole — one row was roughly 15 000
 * characters of Markdown table. `line-clamp-2` hid it visually and hid nothing
 * from the DOM or the accessibility tree, which is how a "collapsed" row came
 * to carry a child's entire deliverable. The full report keeps its home in the
 * expanded card body, which is the surface §8.1 gives it.
 *
 * The first line that carries words, whitespace-collapsed and clipped. Leading
 * Markdown chrome (`#`, `>`, `-`, `*`) is stripped so a report that opens with
 * a heading summarizes as the heading's text rather than as `##`.
 */
export function subagentReportSummary(report: string, limit = 120): string {
  for (const line of report.split('\n')) {
    const text = line
      .replace(/^[\s>#*\-|]+/, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (text.length === 0) continue;
    return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
  }
  return '';
}

export function subagentElapsedMs(
  startedAt: string | undefined,
  endedAt: string | undefined,
  running: boolean,
  now: number,
): number | null {
  const start = parseIsoMs(startedAt);
  if (start === null) return null;
  const end = parseIsoMs(endedAt);
  if (end !== null) return Math.max(0, end - start);
  if (!running) return null;
  return Math.max(0, now - start);
}

function parseIsoMs(value: string | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Elapsed time for the collapsed row's right-aligned meta (§8.1): `45s`,
 * `1m 12s`, `2h 03m`. Seconds are floored (never rounded up into the next unit)
 * and the trailing unit is zero-padded to two digits once a larger unit is
 * shown. Byte-identical to `apps/web`'s `formatElapsed` and iOS's
 * `SubagentFormat.elapsed(_:)`; all three are asserted against
 * `scripts/fixtures/rendering-fixtures.json`.
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
 * `12 tool uses`. Byte-identical to the web and iOS twins.
 */
export function formatToolCount(n: number): string {
  return `${n} tool ${n === 1 ? 'use' : 'uses'}`;
}

/**
 * Human label for a card status, in ONE place: the transcript card and the
 * panel row must not drift into two vocabularies for the same seven values.
 */
export const SUBAGENT_STATUS_LABEL: Record<SubagentStatus, string> = {
  running: 'Running',
  waiting: 'Waiting for input',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
  interrupted: 'Interrupted',
  max_turns: 'Max turns reached',
};

/** Summary counts for the pinned swarm strip. */
export interface SwarmStripSummary {
  total: number;
  running: number;
  waiting: number;
  /** Per-child state in anchor order, for the status dots. */
  workers: { subagentId: string; type: string; status: SubagentStatus }[];
}

/**
 * Derive the pinned-strip summary from a message's live events. Only non-orphan
 * groups (real starts) are counted — an orphan terminal is a finished child
 * from a prior message and does not represent live work.
 *
 * Returns null when there are no non-terminal children (nothing to pin). Reads
 * the FOLD alone, deliberately: the strip is pinned above the composer of the
 * message that is streaming, so its children are exactly the ones whose events
 * are arriving, and it must not flicker on a list read's round trip.
 */
export function summarizeSwarmStrip(
  events: readonly McAgentEvent[],
  isStreaming: boolean,
): SwarmStripSummary | null {
  const workers: SwarmStripSummary['workers'] = [];
  let running = 0;
  let waiting = 0;
  let hasNonTerminal = false;

  for (const group of groupSubagentEvents(events, isStreaming)) {
    if (group.orphan) continue;
    workers.push({ subagentId: group.subagentId, type: group.type, status: group.status });
    if (group.status === 'running') running++;
    else if (group.status === 'waiting') waiting++;
    if (!isTerminalSubagentStatus(group.status)) hasNonTerminal = true;
  }

  if (!hasNonTerminal) return null;

  return { total: workers.length, running, waiting, workers };
}
