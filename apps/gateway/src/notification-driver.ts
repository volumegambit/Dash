import type { NotificationDriver } from '@dash/swarm';
import { ChildTurnStartError } from '@dash/swarm';
import type { RegisteredAgent } from './agent-registry.js';
import { ConversationServiceError } from './conversation-service.js';
import type { ConversationService } from './conversation-service.js';
import type { ResumableChatHub } from './resumable-chat-hub.js';
import { isSubagentsEnabled } from './subagent-config.js';

export interface NotificationDriverOptions {
  conversations: ConversationService;
  /** Late-bound: the hub is constructed after the coordinator (see index.ts). */
  hub: () => ResumableChatHub | undefined;
  agentRegistry: { get(agentId: string): RegisteredAgent | undefined };
  warn: (message: string) => void;
}

/**
 * The gateway's real {@link NotificationDriver}: the `pending_notifications`
 * table for durability and the shared `ResumableChatHub` for the
 * server-initiated parent turn (design §7.3).
 */
export function createNotificationDriver(options: NotificationDriverOptions): NotificationDriver {
  return {
    // Durable first (ruling 1): the row is committed before anything tries to
    // deliver it. `enqueueNotification` takes ONE argument — the notification.
    enqueue: (notification) => options.conversations.enqueueNotification(notification),

    // NON-destructive (ruling 1 again): the rows survive a failed delivery
    // attempt in place, so nothing is lost if the process dies mid-attempt and
    // their `created_at` ordering is never re-stamped (ruling 4).
    peek: (conversationId) => options.conversations.peekNotifications(conversationId),

    ack: (ids) => options.conversations.ackNotifications(ids),

    startNotificationTurn(agentId, conversationId, text, turnId) {
      const hub = options.hub();
      if (!hub) {
        throw new ChildTurnStartError('stopped', 'the gateway chat hub is not running');
      }

      // Bounded failure (ruling 8): an agent that has been deleted, disabled or
      // had sub-agents turned off must not have turns started on it. Same
      // predicate the merge wrapper's spawn gate uses — `config.enabled` is not
      // a field GatewayAgentConfig has, so reading it never fires.
      const entry = options.agentRegistry.get(agentId);
      if (!entry) {
        throw new ChildTurnStartError('error', `Agent ${agentId} is no longer registered`);
      }
      if (entry.status === 'disabled' || !isSubagentsEnabled(entry.config)) {
        throw new ChildTurnStartError('error', `Agent ${agentId} is not accepting sub-agent turns`);
      }

      try {
        // Ruling 2: `acceptTurn` decides idle vs busy. No pre-check.
        return hub.startSystemTurn({
          agentId,
          conversationId,
          text,
          origin: 'notification',
          turnId,
        });
      } catch (err) {
        // TWO shapes reach here and they mean different things (same
        // distinction as createChildTurnDriver.startTurn). `acceptTurn` throws
        // a typed `conversation_busy` when the parent still holds its turn
        // lease — retryable, and the COMMON case, because delivery is attempted
        // from the finishing turn's own hook. Everything else typed is the
        // parent being gone. A STOPPED hub throws a BARE Error ("Resumable chat
        // hub is stopped"), which is terminal. Letting any of these escape
        // untranslated makes the coordinator's `instanceof ChildTurnStartError`
        // test false, so a busy parent would take the unclassified path.
        if (err instanceof ConversationServiceError) {
          const reason = err.code === 'conversation_busy' ? 'busy' : 'error';
          throw new ChildTurnStartError(reason, err.message);
        }
        throw new ChildTurnStartError('stopped', err instanceof Error ? err.message : String(err));
      }
    },

    warn: (message) => options.warn(`[notification] ${message}`),
  };
}
