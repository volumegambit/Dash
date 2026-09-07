import type { GatewayAdmissionController } from './admission-controller.js';
import type { ConversationService } from './conversation-service.js';
import type { EventLogStore } from './event-log-store.js';
import {
  type SwarmLogRecoveryOptions,
  type SwarmLogRecoveryResult,
  recoverInterruptedSwarmTurns,
} from './swarm-log-recovery.js';

type RecoveryConversations = Pick<
  ConversationService,
  'listActiveRunsForRecovery' | 'appendCurrentRunEvent' | 'recoverV2State'
>;

export interface GatewayRecoveryOptions {
  eventLog: EventLogStore;
  conversations: RecoveryConversations;
  admission?: Pick<
    GatewayAdmissionController,
    'markRecoveryRequired' | 'beginRecoveryCleanup' | 'clearRecoveryRequired'
  >;
  isDeletionMarked?: (agentId: string) => boolean;
  restoreRun?: SwarmLogRecoveryOptions['restoreRun'];
  log?: (message: string) => void;
}

export interface GatewayRecoveryResult {
  swarm: SwarmLogRecoveryResult;
  conversations: ReturnType<RecoveryConversations['recoverV2State']>;
  excludedConversationIds: string[];
}

const recoveryQuarantines = new WeakMap<object, Set<string>>();

export function recoverGatewayTurns(options: GatewayRecoveryOptions): GatewayRecoveryResult {
  const quarantined = options.admission
    ? (recoveryQuarantines.get(options.admission) ?? new Set<string>())
    : undefined;
  if (options.admission && quarantined) recoveryQuarantines.set(options.admission, quarantined);
  const activeRuns = options.conversations.listActiveRunsForRecovery();
  const swarm = recoverInterruptedSwarmTurns({
    eventLog: options.eventLog,
    canonicalRuns: activeRuns.map((run) => ({
      agentId: run.agentId,
      conversationId: run.conversationId,
      outerRunId: run.runId,
    })),
    appendCurrentRunEvent: (agentId, conversationId, outerRunId, event) =>
      options.conversations.appendCurrentRunEvent(agentId, conversationId, outerRunId, event),
    restoreRun: options.restoreRun,
    log: options.log,
  });

  const activeByConversation = new Map(activeRuns.map((run) => [run.conversationId, run]));
  const excluded = new Set<string>();
  for (const conversationId of swarm.failedCanonicalConversationIds) {
    const run = activeByConversation.get(conversationId);
    if (!run) continue;
    options.admission?.markRecoveryRequired(run.agentId, conversationId);
    quarantined?.add(`${run.agentId}\u0000${conversationId}`);
    if (options.isDeletionMarked?.(run.agentId)) {
      for (const sibling of activeRuns) {
        if (sibling.agentId === run.agentId) excluded.add(sibling.conversationId);
      }
    } else {
      excluded.add(conversationId);
    }
  }

  const conversations = options.conversations.recoverV2State({
    excludeConversationIds: excluded,
  });

  for (const conversationId of swarm.canonicalConversationsRepaired) {
    if (excluded.has(conversationId)) continue;
    const run = activeByConversation.get(conversationId);
    if (!run || !options.admission) continue;
    const quarantineKey = `${run.agentId}\u0000${conversationId}`;
    if (!quarantined?.has(quarantineKey)) continue;
    const cleanupToken = options.admission.beginRecoveryCleanup(run.agentId, conversationId);
    options.admission.clearRecoveryRequired(run.agentId, conversationId, cleanupToken);
    quarantined.delete(quarantineKey);
  }

  return {
    swarm,
    conversations,
    excludedConversationIds: [...excluded],
  };
}

export interface GatewayStartupOrchestratorOptions {
  restoreDeletionFences(): void | Promise<void>;
  repairCanonicalWorkers(): void | Promise<void>;
  recoverV2State(): void | Promise<void>;
  pauseDisabledAgentQueues(): void | Promise<void>;
  createAgentCoordinator(): void | Promise<void>;
  createResumableChatHub(): void | Promise<void>;
  resumePendingAgentDeletions(): void | Promise<void>;
  resumeRecoveredQueues(): void | Promise<void>;
  startRestoredChannelAdapters(): void | Promise<void>;
  startListeners(): void | Promise<void>;
  startRelayDial(): void | Promise<void>;
  ready(): void | Promise<void>;
}

/**
 * The boot barrier is intentionally boring and sequential. Each phase owns a
 * durable handoff that must settle before any restored source can synchronously
 * deliver ingress into the next process.
 */
export async function orchestrateGatewayStartup(
  options: GatewayStartupOrchestratorOptions,
): Promise<void> {
  await options.restoreDeletionFences();
  await options.repairCanonicalWorkers();
  await options.recoverV2State();
  await options.pauseDisabledAgentQueues();
  await options.createAgentCoordinator();
  await options.createResumableChatHub();
  await options.resumePendingAgentDeletions();
  await options.resumeRecoveredQueues();
  await options.startRestoredChannelAdapters();
  await options.startListeners();
  await options.startRelayDial();
  await options.ready();
}
