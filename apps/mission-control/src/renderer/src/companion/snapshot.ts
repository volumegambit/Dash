import type { CompanionSnapshot } from './types.js';

export interface ChatLike {
  conversations: CompanionSnapshot['conversations'];
  selectedConversationRef: CompanionSnapshot['selectedConversationRef'];
  messages: CompanionSnapshot['messages'];
  streamingFrames: CompanionSnapshot['streamingFrames'];
  sending: CompanionSnapshot['sending'];
  unreadConversations: CompanionSnapshot['unreadConversations'];
}

export interface AgentsLike {
  agents: { id: string; name: string }[];
}

export function buildSnapshot(chat: ChatLike, agents: AgentsLike): CompanionSnapshot {
  return {
    conversations: chat.conversations,
    selectedConversationRef: chat.selectedConversationRef,
    messages: chat.messages,
    streamingFrames: chat.streamingFrames,
    sending: chat.sending,
    unreadConversations: chat.unreadConversations,
    agentName: (id) => agents.agents.find((agent) => agent.id === id)?.name ?? 'Agent',
  };
}
