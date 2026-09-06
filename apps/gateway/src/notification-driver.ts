import type { NotificationDriver, PendingNotification } from '@dash/swarm';
import { ChildTurnStartError } from '@dash/swarm';
import type { ConversationService } from './conversation-service.js';
import type { ResumableChatHub } from './resumable-chat-hub.js';

/**
 * Gateway's real implementation of NotificationDriver.
 * Enqueues notifications durably, drains per-parent, and delivers via
 * server-initiated turns on the hub (design §7.3).
 */
export function createNotificationDriver(options: {
  conversations: ConversationService;
  hub: () => ResumableChatHub | undefined;
  agentRegistry: {
    get(agentId: string): { config: { enabled?: boolean } } | undefined;
  };
}): NotificationDriver {
  return {
    enqueue(n) {
      // Durable first (ruling 1): persist before any delivery attempt.
      const row = options.conversations.enqueueNotification(n.conversationId, n);
      return row;
    },

    drain(conversationId) {
      return options.conversations.drainNotifications(conversationId);
    },

    startNotificationTurn(agentId, conversationId, text) {
      const hub = options.hub();
      if (!hub) throw new Error('Hub is stopped');

      // Check if agent is enabled (ruling 8: bounded failure).
      const agent = options.agentRegistry.get(agentId);
      if (agent && agent.config.enabled === false) {
        throw new Error(`Agent ${agentId} is disabled`);
      }

      // acceptTurn decides idle (ruling 2: no pre-check).
      // Throws ChildTurnStartError on conversation_busy or other failures.
      const result = hub.startSystemTurn({
        agentId,
        conversationId,
        text,
        origin: 'notification',
      });

      return result;
    },

    warn(message) {
      console.warn(`[notification] ${message}`);
    },
  };
}
