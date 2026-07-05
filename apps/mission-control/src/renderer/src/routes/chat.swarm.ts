/**
 * Pure fold logic for swarm worker events in the chat transcript.
 *
 * The agent backend interleaves `worker_spawned` / `worker_status` /
 * `worker_done` events into an assistant message's event list alongside the
 * usual text/thinking/tool events. This module pre-scans a message's events
 * and groups every worker_* event by `workerId` so the renderer can draw ONE
 * card per worker (at the spawn position) sourcing the worker's whole lifecycle
 * — the status/done events themselves render nothing standalone.
 *
 * Crash-reconcile can split a single worker run across two persisted messages:
 * the spawn lands in message A and the terminal `worker_done` in message B.
 * In message B the terminal event is "orphaned" (no spawn in the same event
 * list); those are surfaced separately so the renderer can draw a compact
 * standalone "worker finished" card from the event's self-describing `role`.
 *
 * All functions here are framework-free pure functions so they can be
 * unit-tested under the app's vitest config without a DOM. The presentational
 * components live in `chat.tsx`.
 */

import type { McAgentEvent } from '../../../shared/ipc.js';

/** The worker event variants, narrowed from the McAgentEvent union. */
export type WorkerSpawnedEvent = Extract<McAgentEvent, { type: 'worker_spawned' }>;
export type WorkerStatusEvent = Extract<McAgentEvent, { type: 'worker_status' }>;
export type WorkerDoneEvent = Extract<McAgentEvent, { type: 'worker_done' }>;

/** Coarse lifecycle state a WorkerCard renders. */
export type WorkerCardStatus = 'running' | 'waiting' | 'done' | 'failed' | 'cancelled';

/**
 * All events belonging to a single worker within one message, in arrival
 * order. `spawned` is present for a normal (non-orphan) group. `done` is the
 * terminal event when it arrived in this message.
 */
export interface WorkerGroup {
  workerId: string;
  /** Self-describing role, sourced from whichever event we saw first. */
  role: string;
  /** Model id from the spawn event, when available. */
  model?: string;
  /** Kickoff brief from the spawn event, when available. */
  brief?: string;
  /** The spawn event, or undefined when this group is an orphan terminal. */
  spawned?: WorkerSpawnedEvent;
  /** The `worker_status` events in arrival order. */
  statuses: WorkerStatusEvent[];
  /** The terminal `worker_done` event, when it arrived in this message. */
  done?: WorkerDoneEvent;
  /**
   * Index into the source `events` array at which this group's card should
   * render: the spawn position for a normal group, or the orphan terminal's
   * position for an orphan group.
   */
  anchorIndex: number;
  /**
   * True when this group has no `worker_spawned` in the message — a terminal
   * event split off by crash-reconcile. Renders as a compact standalone card.
   */
  orphan: boolean;
}

/**
 * Group every `worker_*` event in a message's event list by `workerId`,
 * preserving first-seen order. A group is a "normal" group when it contains a
 * `worker_spawned`; a group whose only events are terminal/status ones (no
 * spawn in THIS message) is an `orphan` group.
 */
export function groupWorkerEvents(events: Record<string, unknown>[]): Map<string, WorkerGroup> {
  const groups = new Map<string, WorkerGroup>();

  for (let i = 0; i < events.length; i++) {
    const event = events[i] as McAgentEvent;
    if (
      event.type !== 'worker_spawned' &&
      event.type !== 'worker_status' &&
      event.type !== 'worker_done'
    ) {
      continue;
    }

    let group = groups.get(event.workerId);
    if (!group) {
      group = {
        workerId: event.workerId,
        role: event.role,
        statuses: [],
        anchorIndex: i,
        // Provisionally an orphan until (and unless) we see a spawn.
        orphan: event.type !== 'worker_spawned',
      };
      groups.set(event.workerId, group);
    }

    if (event.type === 'worker_spawned') {
      group.spawned = event;
      group.model = event.model;
      group.brief = event.brief;
      group.role = event.role;
      // The card anchors at the spawn position; a spawn always de-orphans.
      group.anchorIndex = i;
      group.orphan = false;
    } else if (event.type === 'worker_status') {
      group.statuses.push(event);
      if (event.role) group.role = event.role;
    } else if (event.type === 'worker_done') {
      group.done = event;
      if (event.role) group.role = event.role;
    }
  }

  return groups;
}

/**
 * Resolve the effective card status for a group, applying end-of-stream
 * terminalization: when the stream has ended (`!isStreaming`) a group that
 * never reached a terminal `worker_done` is treated as `cancelled` — the run
 * is over and this worker simply never reported back.
 */
export function deriveWorkerStatus(group: WorkerGroup, isStreaming: boolean): WorkerCardStatus {
  if (group.done) {
    // worker_done.status is one of 'done' | 'failed' | 'cancelled'.
    return group.done.status;
  }

  if (!isStreaming) {
    // Stream ended with no terminal event → the worker was left hanging.
    return 'cancelled';
  }

  // Still streaming: reflect the latest status event, defaulting to running.
  const latest = group.statuses[group.statuses.length - 1];
  if (latest?.status === 'waiting_input') return 'waiting';
  return 'running';
}

/** A card status is terminal when the worker has finished (any outcome). */
export function isTerminalStatus(status: WorkerCardStatus): boolean {
  return status === 'done' || status === 'failed' || status === 'cancelled';
}

/**
 * One-line detail for the collapsed card: the newest status `detail` (or the
 * pending `question` when waiting on input), else the brief.
 */
export function latestWorkerDetail(group: WorkerGroup): string | undefined {
  for (let i = group.statuses.length - 1; i >= 0; i--) {
    const s = group.statuses[i];
    if (s.status === 'waiting_input' && s.question) return s.question;
    if (s.detail) return s.detail;
  }
  return group.brief;
}

/** Summary counts for the pinned swarm strip. */
export interface SwarmStripSummary {
  total: number;
  running: number;
  waiting: number;
  /** Per-worker state in group order, for the status dots. */
  workers: { workerId: string; role: string; status: WorkerCardStatus }[];
}

/**
 * Derive the pinned-strip summary from a message's live events. Only the
 * non-orphan groups (real spawns) are counted — an orphan terminal is a
 * finished worker from a prior message and does not represent live work.
 *
 * Returns null when there are no non-terminal workers (nothing to pin).
 */
export function summarizeSwarmStrip(
  events: McAgentEvent[],
  isStreaming: boolean,
): SwarmStripSummary | null {
  const groups = groupWorkerEvents(events);
  const workers: SwarmStripSummary['workers'] = [];
  let running = 0;
  let waiting = 0;
  let hasNonTerminal = false;

  for (const group of groups.values()) {
    if (group.orphan) continue;
    const status = deriveWorkerStatus(group, isStreaming);
    workers.push({ workerId: group.workerId, role: group.role, status });
    if (status === 'running') running++;
    else if (status === 'waiting') waiting++;
    if (!isTerminalStatus(status)) hasNonTerminal = true;
  }

  if (!hasNonTerminal) return null;

  return { total: workers.length, running, waiting, workers };
}
