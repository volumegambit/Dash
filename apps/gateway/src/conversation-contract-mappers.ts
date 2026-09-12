import type { ConversationMessage, ConversationSummary } from '@dash/mobile-contract';
import type {
  MobileV2ConversationMessage,
  MobileV2ConversationSummary,
} from '@dash/mobile-contract-v2';
import type { StoredConversation, StoredConversationMessage } from './conversation-domain.js';

export function mapConversationV1(conversation: StoredConversation): ConversationSummary {
  return {
    id: conversation.id,
    agentId: conversation.agentId,
    agentName: conversation.agentName,
    title: conversation.title,
    revision: conversation.revision,
    status: conversation.status,
    activeTurnId: conversation.activeRunId,
    owningIssueId: conversation.owningIssueId,
    projectId: conversation.projectId,
    lastSeq: conversation.lastSeq,
    lastMessagePreview: conversation.lastMessagePreview,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    ...(conversation.deletedAt !== undefined ? { deletedAt: conversation.deletedAt } : {}),
    kind: conversation.kind ?? 'user',
    ...(conversation.parentConversationId !== undefined
      ? { parentConversationId: conversation.parentConversationId }
      : {}),
    ...(conversation.parentTurnId !== undefined ? { parentTurnId: conversation.parentTurnId } : {}),
    ...(conversation.subagent !== undefined ? { subagent: conversation.subagent } : {}),
  };
}

export function mapConversationV2(conversation: StoredConversation): MobileV2ConversationSummary {
  return {
    ...mapConversationV1(conversation),
    queuePaused: conversation.queuePaused,
    queueRevision: conversation.queueRevision,
    pendingFollowUpCount: conversation.pendingFollowUpCount,
    v2LastSeq: conversation.v2LastSeq,
  };
}

export function mapMessageV1(message: StoredConversationMessage): ConversationMessage {
  return {
    id: message.id,
    conversationId: message.conversationId,
    turnId: message.turnId,
    ordinal: message.ordinal,
    role: message.role,
    status: message.status,
    content: message.content,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
    ...(message.origin !== undefined ? { origin: message.origin } : {}),
  };
}

export function mapMessageV2(message: StoredConversationMessage): MobileV2ConversationMessage {
  return {
    ...mapMessageV1(message),
    runId: message.runId,
    segmentIndex: message.segmentIndex,
    deliveryKind: message.deliveryKind,
    ...(message.deliveryStatus !== undefined ? { deliveryStatus: message.deliveryStatus } : {}),
  };
}
