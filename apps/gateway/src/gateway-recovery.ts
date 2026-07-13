import type { ConversationService } from './conversation-service.js';
import type { EventLogStore } from './event-log-store.js';
import {
  type SwarmLogRecoveryOptions,
  type SwarmLogRecoveryResult,
  recoverInterruptedSwarmTurns,
} from './swarm-log-recovery.js';

export interface GatewayRecoveryOptions {
  eventLog: EventLogStore;
  conversations: Pick<ConversationService, 'recoverInterruptedTurns'>;
  restoreRun?: SwarmLogRecoveryOptions['restoreRun'];
  log?: (message: string) => void;
}

export interface GatewayRecoveryResult {
  swarm: SwarmLogRecoveryResult;
  conversations: { conversationsInterrupted: number; terminalsAppended: number };
}

export function recoverGatewayTurns(options: GatewayRecoveryOptions): GatewayRecoveryResult {
  const swarm = recoverInterruptedSwarmTurns({
    eventLog: options.eventLog,
    restoreRun: options.restoreRun,
    log: options.log,
  });
  const conversations = options.conversations.recoverInterruptedTurns();
  return { swarm, conversations };
}
