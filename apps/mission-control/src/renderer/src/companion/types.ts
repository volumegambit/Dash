import type { McConversation, McMessage } from '@dash/mc';
import type { McAgentEvent } from '../../../shared/ipc.js';

export type CompanionStatus = 'working' | 'needs' | 'done' | 'error';

export interface CompanionSession {
  conversationId: string;
  agentId: string;
  agentName: string;
  title: string;
  status: CompanionStatus;
  preview: string;
  since: number;
}

export interface CompanionSnapshot {
  conversations: McConversation[];
  selectedConversationId: string | null;
  messages: Record<string, McMessage[]>;
  streamingEvents: Record<string, McAgentEvent[]>;
  sending: Record<string, boolean>;
  unreadConversations: Set<string>;
  agentName: (agentId: string) => string;
}
