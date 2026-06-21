import type { CompanionSnapshot } from './types.js';

export interface ChatLike {
  conversations: CompanionSnapshot['conversations'];
  selectedConversationId: string | null;
  messages: CompanionSnapshot['messages'];
  streamingEvents: CompanionSnapshot['streamingEvents'];
  sending: CompanionSnapshot['sending'];
  unreadConversations: Set<string>;
}

export interface AgentsLike {
  agents: { id: string; name: string }[];
}

export function buildSnapshot(chat: ChatLike, agents: AgentsLike): CompanionSnapshot {
  return {
    conversations: chat.conversations,
    selectedConversationId: chat.selectedConversationId,
    messages: chat.messages,
    streamingEvents: chat.streamingEvents,
    sending: chat.sending,
    unreadConversations: chat.unreadConversations,
    agentName: (id) => agents.agents.find((a) => a.id === id)?.name ?? 'Agent',
  };
}
