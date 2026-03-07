import type { McConversation, McMessage } from '@dash/mc';
import { create } from 'zustand';
import type { McAgentEvent } from '../../../shared/ipc.js';

interface ChatState {
  conversations: McConversation[];
  selectedConversationId: string | null;
  messages: Record<string, McMessage[]>;
  streamingEvents: Record<string, McAgentEvent[]>;
  sending: Record<string, boolean>;

  loadConversations(deploymentId: string): Promise<void>;
  selectConversation(id: string): Promise<void>;
  createConversation(deploymentId: string, agentName: string): Promise<McConversation>;
  deleteConversation(id: string): Promise<void>;
  sendMessage(conversationId: string, text: string): Promise<void>;
  cancelMessage(conversationId: string): void;

  // Called by IPC event listeners
  appendStreamingEvent(conversationId: string, event: McAgentEvent): void;
  finalizeMessage(conversationId: string): void;
  setMessageError(conversationId: string, error: string): void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  conversations: [],
  selectedConversationId: null,
  messages: {},
  streamingEvents: {},
  sending: {},

  async loadConversations(deploymentId: string) {
    const conversations = await window.api.chatListConversations(deploymentId);
    set({ conversations });
  },

  async selectConversation(id: string) {
    set({ selectedConversationId: id });
    if (!get().messages[id]) {
      const messages = await window.api.chatGetMessages(id);
      set((s) => ({ messages: { ...s.messages, [id]: messages } }));
    }
  },

  async createConversation(deploymentId: string, agentName: string) {
    const conversation = await window.api.chatCreateConversation(deploymentId, agentName);
    set((s) => ({
      conversations: [...s.conversations, conversation],
      messages: { ...s.messages, [conversation.id]: [] },
    }));
    return conversation;
  },

  async deleteConversation(id: string) {
    await window.api.chatDeleteConversation(id);
    set((s) => {
      const { [id]: _m, ...restMessages } = s.messages;
      const { [id]: _se, ...restEvents } = s.streamingEvents;
      return {
        conversations: s.conversations.filter((c) => c.id !== id),
        selectedConversationId: s.selectedConversationId === id ? null : s.selectedConversationId,
        messages: restMessages,
        streamingEvents: restEvents,
      };
    });
  },

  async sendMessage(conversationId: string, text: string) {
    // Optimistic user message for instant UI feedback
    const userMsg: McMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: { type: 'user', text },
      timestamp: new Date().toISOString(),
    };
    set((s) => ({
      messages: {
        ...s.messages,
        [conversationId]: [...(s.messages[conversationId] ?? []), userMsg],
      },
      streamingEvents: { ...s.streamingEvents, [conversationId]: [] },
      sending: { ...s.sending, [conversationId]: true },
    }));
    try {
      await window.api.chatSendMessage(conversationId, text);
    } catch (err) {
      set((s) => ({ sending: { ...s.sending, [conversationId]: false } }));
      throw err;
    }
  },

  cancelMessage(conversationId: string) {
    window.api.chatCancel(conversationId);
    set((s) => ({ sending: { ...s.sending, [conversationId]: false } }));
  },

  appendStreamingEvent(conversationId: string, event: McAgentEvent) {
    set((s) => ({
      streamingEvents: {
        ...s.streamingEvents,
        [conversationId]: [...(s.streamingEvents[conversationId] ?? []), event],
      },
    }));
  },

  finalizeMessage(conversationId: string) {
    const events = get().streamingEvents[conversationId] ?? [];
    const assistantMsg: McMessage = {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: { type: 'assistant', events: events as Record<string, unknown>[] },
      timestamp: new Date().toISOString(),
    };
    set((s) => ({
      messages: {
        ...s.messages,
        [conversationId]: [...(s.messages[conversationId] ?? []), assistantMsg],
      },
      streamingEvents: { ...s.streamingEvents, [conversationId]: [] },
      sending: { ...s.sending, [conversationId]: false },
    }));
  },

  setMessageError(conversationId: string, error: string) {
    const errMsg: McMessage = {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: { type: 'assistant', events: [{ type: 'error', error }] },
      timestamp: new Date().toISOString(),
    };
    set((s) => ({
      messages: {
        ...s.messages,
        [conversationId]: [...(s.messages[conversationId] ?? []), errMsg],
      },
      streamingEvents: { ...s.streamingEvents, [conversationId]: [] },
      sending: { ...s.sending, [conversationId]: false },
    }));
  },
}));

// Global IPC event listeners — call once at app startup (see routes/__root.tsx)
let initialized = false;

export function initChatListeners(): void {
  if (initialized) return;
  initialized = true;

  window.api.chatOnEvent((conversationId, event) => {
    useChatStore.getState().appendStreamingEvent(conversationId, event);
  });
  window.api.chatOnDone((conversationId) => {
    useChatStore.getState().finalizeMessage(conversationId);
  });
  window.api.chatOnError((conversationId, error) => {
    useChatStore.getState().setMessageError(conversationId, error);
  });
}
