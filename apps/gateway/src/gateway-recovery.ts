import type { ConversationService } from './conversation-service.js';
import type { EventLogStore } from './event-log-store.js';
import {
  type PendingDeliveryTarget,
  type SubagentChildRecoveryResult,
  type SubagentRecoveryConversations,
  type SubagentTailRecoveryResult,
  queueInterruptedSubagentNotifications,
  recoverInterruptedSubagentTails,
} from './swarm-log-recovery.js';

export interface GatewayRecoveryOptions {
  eventLog: EventLogStore;
  conversations: Pick<ConversationService, 'recoverInterruptedTurns'> &
    SubagentRecoveryConversations;
  log?: (message: string) => void;
}

export interface GatewayRecoveryResult {
  subagents: SubagentTailRecoveryResult;
  conversations: ReturnType<ConversationService['recoverInterruptedTurns']>;
  notifiedChildren: SubagentChildRecoveryResult;
  /**
   * Parents recovery queued a notification for, deduplicated across both
   * halves. §7.5: the coordinator delivers these "once the hub is up", which
   * is strictly after this function returns — so the caller holds the list
   * and drives `deliverPending` from it at that point.
   */
  pendingDelivery: PendingDeliveryTarget[];
}

/**
 * The gateway's boot recovery, in the ONE order that is correct (design §7.4,
 * §7.5) — see `swarm-log-recovery.ts` for why each side has to sit where it
 * does relative to the generic pass:
 *
 * 1. parent tails — synthesize `subagent_finished{interrupted}` BEFORE any
 *    terminal marker is written, or the marker stops being the log's last
 *    entry and the conversation is interrupted for ever;
 * 2. generic conversation recovery — terminalize turns, and flip every
 *    non-terminal child to `interrupted`;
 * 3. child notifications — read the rows step 2 just flipped and wake their
 *    parents.
 *
 * Runs before any server accepts traffic, so no live turn can exist.
 */
export function recoverGatewayTurns(options: GatewayRecoveryOptions): GatewayRecoveryResult {
  const subagents = recoverInterruptedSubagentTails({
    eventLog: options.eventLog,
    conversations: options.conversations,
    log: options.log,
  });
  const conversations = options.conversations.recoverInterruptedTurns();
  const notifiedChildren = queueInterruptedSubagentNotifications({
    conversations: options.conversations,
    log: options.log,
  });
  const pendingDelivery = new Map<string, PendingDeliveryTarget>();
  for (const target of [...subagents.pendingDelivery, ...notifiedChildren.pendingDelivery]) {
    pendingDelivery.set(target.conversationId, target);
  }
  return {
    subagents,
    conversations,
    notifiedChildren,
    pendingDelivery: [...pendingDelivery.values()],
  };
}
