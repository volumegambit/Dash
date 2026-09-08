import type { AgentEvent } from '@dash/agent';
import type { MobileAgentEvent } from '@dash/mobile-contract';
import type { ConversationService } from './conversation-service.js';
import type { EventLogPayload, EventLogStore } from './event-log-store.js';

/**
 * Boot-time SUB-AGENT recovery — design §7.4 and §7.5.
 *
 * A child is a real conversation now, so the GENERIC `recoverInterruptedTurns`
 * already terminalizes a child's own log, flips its conversation to
 * `interrupted` and (this task) flips its `subagent_status` with it. What that
 * generic pass cannot do is either of the two parent-facing jobs left over,
 * and this module is exactly those two and nothing else:
 *
 *  1. {@link recoverInterruptedSubagentTails} — for every `subagent_started`
 *     in an interrupted PARENT's tail with no matching `subagent_finished`,
 *     append a synthesized `subagent_finished { status: 'interrupted' }` so
 *     replay terminalizes the agent row instead of spinning for ever, and
 *     queue the parent a notification about it.
 *  2. {@link queueInterruptedSubagentNotifications} — for every child ROW the
 *     generic pass just marked `interrupted`, queue that same notification.
 *     This is the case (1) cannot see: a DETACHED background child dies with
 *     its parent idle, so the parent has no interrupted tail at all.
 *
 * What used to live here and is deliberately gone: the whole `worker_*` family
 * (retired in D8 — the mirrors were additive, and the dangling scan has always
 * been driven off `subagent_started`, so a pre-D8 tail is repaired the same
 * way), the
 * synthesized `{type:'error'}` stream marker (the generic recovery appends
 * exactly one, and a second would be a duplicate), and the rebuilt
 * `RunSnapshot` pushed into the coordinator's ring buffer (the panel reads
 * child conversations now — see `swarm-management.ts`).
 *
 * ORDER MATTERS and is fixed by `recoverGatewayTurns`: (1) runs BEFORE the
 * generic pass because an event appended after that pass's terminal marker
 * would leave the log non-terminal again — the conversation would come back
 * "interrupted" on every subsequent boot, for ever. (2) runs AFTER it, because
 * the generic pass is what sets `subagent_status = 'interrupted'` in the first
 * place.
 *
 * Neither step may break boot: every conversation, and every child inside one,
 * is repaired inside its own try/catch. One bad row costs that row another
 * boot, never the gateway.
 */

/** The report a child that was killed by a restart carries. */
export const INTERRUPTED_CHILD_REPORT =
  'The gateway restarted while this agent was running. Its transcript is intact and it can be ' +
  'resumed with send_message.';

type SubagentStartedEvent = Extract<AgentEvent, { type: 'subagent_started' }> & MobileAgentEvent;
type SubagentFinishedEvent = Extract<AgentEvent, { type: 'subagent_finished' }> & MobileAgentEvent;

function isSubagentStarted(event: MobileAgentEvent): event is SubagentStartedEvent {
  return (
    event.type === 'subagent_started' &&
    typeof event.subagentId === 'string' &&
    typeof event.subagentType === 'string' &&
    typeof event.description === 'string' &&
    typeof event.startedAt === 'string'
  );
}

function isSubagentFinished(event: MobileAgentEvent): event is SubagentFinishedEvent {
  return event.type === 'subagent_finished' && typeof event.subagentId === 'string';
}

/** The slice of the conversation service both steps need. */
export type SubagentRecoveryConversations = Pick<
  ConversationService,
  | 'listInterruptedSubagents'
  | 'updateSubagent'
  | 'enqueueNotification'
  | 'peekNotifications'
  | 'get'
>;

export interface SubagentTailRecoveryOptions {
  eventLog: EventLogStore;
  conversations: SubagentRecoveryConversations;
  /** Boot logger; recovery is chatty only about what it changed or skipped. */
  log?: (message: string) => void;
}

/** A parent that now holds at least one queued notification. */
export interface PendingDeliveryTarget {
  agentId: string;
  conversationId: string;
}

export interface SubagentTailRecoveryResult {
  /** Parents whose tail carried at least one dangling child. */
  conversationsRepaired: number;
  /** Synthesized `subagent_finished` events appended. */
  childrenTerminalized: number;
  /** Notifications actually queued (a duplicate or a failure queues none). */
  notificationsQueued: number;
  /**
   * The parents something was queued for. §7.5 says the notification is
   * DELIVERED once the hub is up, and boot recovery runs long before that —
   * so the callers are handed the list to drive `deliverPending` with later.
   * Without it an idle parent sits on the queue until the user happens to
   * type again, because the only other trigger is its own `finishTurn`.
   */
  pendingDelivery: PendingDeliveryTarget[];
}

export interface SubagentChildRecoveryOptions {
  conversations: SubagentRecoveryConversations;
  log?: (message: string) => void;
}

export interface SubagentChildRecoveryResult {
  childrenNotified: number;
  /** See {@link SubagentTailRecoveryResult.pendingDelivery}. */
  pendingDelivery: PendingDeliveryTarget[];
}

/** The `subagent_finished` payload shape the coordinator enqueues on a terminal child. */
function notificationPayload(event: SubagentFinishedEvent): Record<string, unknown> {
  return {
    subagentId: event.subagentId,
    ...(event.name !== undefined ? { name: event.name } : {}),
    subagentType: event.subagentType,
    description: event.description,
    status: event.status,
    report: event.report,
    toolCallCount: event.toolCallCount,
    startedAt: event.startedAt,
    endedAt: event.endedAt,
    ...(event.usage ? { usage: event.usage } : {}),
  };
}

/**
 * Queue one `subagent_finished` notification, unless the parent already holds
 * one for this child.
 *
 * The dedup is a peek rather than bookkeeping between the two steps because
 * BOTH of them can reach the same child — a foreground background-less child
 * dies with its parent's turn open, so it is both a dangling `subagent_started`
 * in the tail and an `interrupted` row — and a parent woken twice about one
 * child reads as two separate failures.
 */
function queueOnce(
  conversations: SubagentRecoveryConversations,
  parentConversationId: string,
  payload: Record<string, unknown>,
): boolean {
  const already = conversations
    .peekNotifications(parentConversationId)
    .some(
      (pending) =>
        pending.kind === 'subagent_finished' && pending.payload.subagentId === payload.subagentId,
    );
  if (already) return false;
  conversations.enqueueNotification({
    conversationId: parentConversationId,
    kind: 'subagent_finished',
    payload,
  });
  return true;
}

/**
 * Step 1 (parent side). See the module comment for why this runs BEFORE
 * `recoverInterruptedTurns`.
 */
export function recoverInterruptedSubagentTails(
  options: SubagentTailRecoveryOptions,
): SubagentTailRecoveryResult {
  const { eventLog, conversations, log } = options;
  let conversationsRepaired = 0;
  let childrenTerminalized = 0;
  let notificationsQueued = 0;
  const pendingDelivery = new Map<string, PendingDeliveryTarget>();

  for (const conv of eventLog.listInterrupted()) {
    try {
      const tail = eventLog.readSince(conv.agentId, conv.conversationId, conv.lastTerminalSeq);

      const started = new Map<string, SubagentStartedEvent>();
      const finished = new Set<string>();
      for (const entry of tail) {
        if (entry.payload.type !== 'event') continue;
        const event = entry.payload.event;
        if (isSubagentStarted(event)) started.set(event.subagentId, event);
        else if (isSubagentFinished(event)) finished.add(event.subagentId);
      }

      const dangling = [...started.values()].filter((event) => !finished.has(event.subagentId));
      if (dangling.length === 0) continue;

      // The dead process cannot have written anything after its last entry, so
      // that timestamp is the latest defensible end time for its children.
      const endedAt = tail[tail.length - 1].timestamp;

      for (const event of dangling) {
        const synthesized: SubagentFinishedEvent = {
          type: 'subagent_finished',
          subagentId: event.subagentId,
          ...(event.name !== undefined ? { name: event.name } : {}),
          subagentType: event.subagentType,
          description: event.description,
          status: 'interrupted',
          report: INTERRUPTED_CHILD_REPORT,
          toolCallCount: 0,
          startedAt: event.startedAt,
          endedAt,
        };

        eventLog.append(conv.agentId, conv.conversationId, conv.lastMsgId, {
          type: 'event',
          event: synthesized,
        });
        childrenTerminalized++;

        // Per-CHILD containment: a parent whose queue is full must not cost the
        // other children of the same parent their notification.
        try {
          if (queueOnce(conversations, conv.conversationId, notificationPayload(synthesized))) {
            notificationsQueued++;
            pendingDelivery.set(conv.conversationId, {
              agentId: conv.agentId,
              conversationId: conv.conversationId,
            });
          }
        } catch (err) {
          log?.(
            `[subagent-recovery] could not queue the interrupted notification for ${event.subagentId} on conversation ${conv.conversationId}: ${describe(err)}`,
          );
        }
      }

      conversationsRepaired++;
      log?.(
        `[subagent-recovery] terminalized ${dangling.length} interrupted child(ren) in ` +
          `conversation ${conv.conversationId} (agent ${conv.agentId})`,
      );
    } catch (err) {
      log?.(
        `[subagent-recovery] failed to repair conversation ${conv.conversationId} ` +
          `(agent ${conv.agentId}): ${describe(err)}`,
      );
    }
  }

  return {
    conversationsRepaired,
    childrenTerminalized,
    notificationsQueued,
    pendingDelivery: [...pendingDelivery.values()],
  };
}

/**
 * Step 2 (child side). See the module comment for why this runs AFTER
 * `recoverInterruptedTurns`.
 *
 * Idempotent across boots on `subagent.endedAt`: an interrupted child that has
 * one has already been finalized by a previous boot (or by the process that
 * interrupted it), so it is skipped. The stamp is written AFTER the enqueue, so
 * a queue that refused leaves the child unstamped and it is retried next boot.
 */
export function queueInterruptedSubagentNotifications(
  options: SubagentChildRecoveryOptions,
): SubagentChildRecoveryResult {
  const { conversations, log } = options;
  let childrenNotified = 0;
  const pendingDelivery = new Map<string, PendingDeliveryTarget>();

  for (const child of conversations.listInterruptedSubagents()) {
    try {
      const info = child.subagent;
      if (!info || info.endedAt) continue;
      const parentConversationId = child.parentConversationId;
      if (!parentConversationId) continue;

      const endedAt = new Date().toISOString();
      const queued = queueOnce(conversations, parentConversationId, {
        subagentId: child.id,
        ...(info.name !== undefined ? { name: info.name } : {}),
        subagentType: info.type,
        description: info.description,
        status: 'interrupted',
        report: info.report ?? INTERRUPTED_CHILD_REPORT,
        toolCallCount: info.toolCallCount,
        startedAt: info.startedAt,
        endedAt,
        ...(info.usage ? { usage: info.usage } : {}),
      });
      conversations.updateSubagent(child.id, { info: { endedAt } });
      if (queued) {
        childrenNotified++;
        pendingDelivery.set(parentConversationId, {
          agentId: child.agentId,
          conversationId: parentConversationId,
        });
      }
    } catch (err) {
      log?.(
        `[subagent-recovery] failed to queue the interrupted notification for child ${child.id}: ${describe(err)}`,
      );
    }
  }

  return { childrenNotified, pendingDelivery: [...pendingDelivery.values()] };
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
