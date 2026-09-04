import type { ConversationRef, McConversationView } from '@dash/mc';
import type { ConversationMessage, MobileWsServerFrame } from '@dash/mobile-contract';
import type { CompanionStatus } from '../../../shared/ipc.js';
import type { ConversationKey } from '../stores/chat.js';

export type { CompanionStatus } from '../../../shared/ipc.js';

export interface CompanionSession {
  conversation: ConversationRef;
  conversationKey: ConversationKey;
  agentId: string;
  agentName: string;
  title: string;
  status: CompanionStatus;
  preview: string;
  since: number;
}

export interface CompanionSnapshot {
  conversations: McConversationView[];
  selectedConversationRef: ConversationRef | null;
  messages: Record<ConversationKey, ConversationMessage[]>;
  streamingFrames: Record<ConversationKey, MobileWsServerFrame[]>;
  sending: Record<ConversationKey, boolean>;
  unreadConversations: Set<ConversationKey>;
  agentName: (agentId: string) => string;
}
