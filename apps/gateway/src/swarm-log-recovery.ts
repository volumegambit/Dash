import type { AgentEvent } from '@dash/agent';
import type { MobileAgentEvent } from '@dash/mobile-contract';
import type { RunSnapshot } from '@dash/swarm';
import type { EventLogPayload, EventLogStore } from './event-log-store.js';

/**
 * Boot-time repair of swarm turns a previous gateway process died in the
 * middle of.
 *
 * When the gateway is killed mid-swarm-run, nothing gets to write the
 * conversation's terminal state: the workers' `worker_done` events are never
 * appended (SwarmCoordinator.finalizeTurn never ran) and the stream never logs
 * its `done`/`error` marker. The durable event log then ends with
 * `worker_spawned` events that hang forever — MC's replay renders permanently
 * spinning worker cards and a spinning wait_workers tool block, and the swarm
 * panel (fed by the coordinator's in-memory ring buffer) knows nothing about
 * the run at all.
 *
 * This scan runs once at boot, BEFORE any server accepts traffic (so no live
 * turn can exist). For every conversation whose log tail — the entries after
 * its last `done`/`error` marker — contains dangling workers (spawned, no
 * terminal event), it:
 *
 *   1. appends a synthesized `worker_done{cancelled}` per dangling worker,
 *   2. appends one terminal `{type:'error'}` stream marker, and
 *   3. rebuilds a finalized RunSnapshot from the tail for the panel history.
 *
 * Deliberately-cancelled turns are untouched: a user cancel never logs a
 * stream marker either, but `cancelTurn` DID append every worker's terminal
 * event out-of-band, so those turns have no dangling workers. Interrupted
 * non-swarm turns are also untouched — MC already renders their unresolved
 * tool calls as interrupted, and stamping errors onto every historical
 * cancel/drop would be wrong.
 *
 * Idempotent: step 2 makes the conversation's newest entry terminal, so the
 * next boot's `listInterrupted` no longer returns it.
 */

type WorkerSpawnedEvent = Extract<AgentEvent, { type: 'worker_spawned' }> & MobileAgentEvent;
type WorkerDoneEvent = Extract<AgentEvent, { type: 'worker_done' }> & MobileAgentEvent;

function isWorkerSpawnedEvent(event: MobileAgentEvent): event is WorkerSpawnedEvent {
  return (
    event.type === 'worker_spawned' &&
    typeof event.workerId === 'string' &&
    typeof event.runId === 'string' &&
    typeof event.role === 'string' &&
    typeof event.brief === 'string' &&
    typeof event.model === 'string'
  );
}

function isWorkerDoneEvent(event: MobileAgentEvent): event is WorkerDoneEvent {
  return (
    event.type === 'worker_done' &&
    typeof event.workerId === 'string' &&
    typeof event.runId === 'string' &&
    typeof event.role === 'string' &&
    (event.status === 'done' || event.status === 'failed' || event.status === 'cancelled') &&
    typeof event.report === 'string'
  );
}

const CANCELLED_WORKER_REPORT = 'Gateway restarted while this worker was running.';
const TURN_ERROR =
  'Gateway restarted while this swarm run was in progress — remaining workers were cancelled.';
const TURN_ERROR_PAYLOAD = { type: 'error', error: TURN_ERROR } satisfies EventLogPayload;

export interface SwarmLogRecoveryOptions {
  eventLog: EventLogStore;
  /** Push a reconstructed finalized snapshot into the panel history. */
  restoreRun?: (snapshot: RunSnapshot) => void;
  /** Boot logger; recovery is chatty only about what it changed or skipped on error. */
  log?: (message: string) => void;
}

export interface SwarmLogRecoveryResult {
  conversationsRepaired: number;
  workersCancelled: number;
}

export function recoverInterruptedSwarmTurns(
  options: SwarmLogRecoveryOptions,
): SwarmLogRecoveryResult {
  const { eventLog, restoreRun, log } = options;
  let conversationsRepaired = 0;
  let workersCancelled = 0;

  for (const conv of eventLog.listInterrupted()) {
    // A failure in one conversation must never break boot or the rest of
    // the scan — log it and move on; that conversation stays interrupted
    // and gets another chance on the next boot.
    try {
      const tail = eventLog.readSince(conv.agentId, conv.conversationId, conv.lastTerminalSeq);

      // Group the tail's swarm events. Spawn order is preserved by seq order.
      const spawns = new Map<string, { event: WorkerSpawnedEvent; timestamp: string }>();
      const terminals = new Map<string, WorkerDoneEvent>();
      for (const entry of tail) {
        if (entry.payload.type !== 'event') continue;
        const event = entry.payload.event;
        if (isWorkerSpawnedEvent(event)) {
          spawns.set(event.workerId, { event, timestamp: entry.timestamp });
        } else if (isWorkerDoneEvent(event)) {
          terminals.set(event.workerId, event);
        }
      }
      if (spawns.size === 0) continue; // interrupted, but not a swarm turn

      const dangling = [...spawns.values()].filter(({ event }) => !terminals.has(event.workerId));
      if (dangling.length === 0) continue; // every worker already terminal (e.g. user cancel)

      // 1) Synthesize a terminal event per dangling worker, keyed to the
      //    interrupted message so replay consumers correlate them.
      for (const { event } of dangling) {
        const synthesized: WorkerDoneEvent = {
          type: 'worker_done',
          workerId: event.workerId,
          runId: event.runId,
          role: event.role,
          status: 'cancelled',
          report: CANCELLED_WORKER_REPORT,
          usage: { inputTokens: 0, outputTokens: 0 },
        };
        eventLog.append(conv.agentId, conv.conversationId, conv.lastMsgId, {
          type: 'event',
          event: synthesized,
        });
        terminals.set(event.workerId, synthesized);
      }

      // 2) One terminal stream marker: the turn ended in an error, not
      //    silence. MC's reconcile fires its error path off this.
      eventLog.append(conv.agentId, conv.conversationId, conv.lastMsgId, TURN_ERROR_PAYLOAD);

      // 3) Rebuild the run for the panel. Timestamps come from the log
      //    itself: the run started at its first spawn and can't have
      //    outlived the last thing the dead process wrote.
      const ordered = [...spawns.values()];
      const runId = ordered[0].event.runId;
      const startedAt = Date.parse(ordered[0].timestamp);
      const endedAt = Date.parse(tail[tail.length - 1].timestamp);
      restoreRun?.({
        runId,
        agentId: conv.agentId,
        conversationId: conv.conversationId,
        startedAt,
        endedAt,
        finalized: true,
        workerCount: ordered.length,
        activeCount: 0,
        workers: ordered.map(({ event }) => {
          const terminal = terminals.get(event.workerId) as WorkerDoneEvent;
          return {
            workerId: event.workerId,
            role: event.role,
            status: terminal.status,
            brief: event.brief,
            model: event.model,
            report: terminal.report,
            usage: terminal.usage ?? { inputTokens: 0, outputTokens: 0 },
          };
        }),
      });

      conversationsRepaired++;
      workersCancelled += dangling.length;
      log?.(
        `[swarm-recovery] terminalized ${dangling.length} dangling worker(s) in conversation ${conv.conversationId} (agent ${conv.agentId}, run ${runId})`,
      );
    } catch (err) {
      log?.(
        `[swarm-recovery] failed to repair conversation ${conv.conversationId} (agent ${conv.agentId}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return { conversationsRepaired, workersCancelled };
}
