import type { McConversation, McMessage } from '@dash/mc';
import { create } from 'zustand';
import type { McAgentEvent } from '../../../shared/ipc.js';

interface ChatState {
  conversations: McConversation[];
  selectedConversationId: string | null;
  messages: Record<string, McMessage[]>;
  streamingEvents: Record<string, McAgentEvent[]>;
  sending: Record<string, boolean>;
  unreadConversations: Set<string>;

  loadConversations(): Promise<void>;
  loadAllConversations(): Promise<void>;
  selectConversation(id: string): Promise<void>;
  createConversation(agentId: string): Promise<McConversation>;
  renameConversation(id: string, title: string): Promise<void>;
  deleteConversation(id: string): Promise<void>;
  sendMessage(conversationId: string, text: string): Promise<void>;
  cancelMessage(conversationId: string): void;

  // Called by IPC event listeners
  appendStreamingEvent(conversationId: string, event: McAgentEvent): void;
  finalizeMessage(conversationId: string): void;
  setMessageError(conversationId: string, error: string): void;
}

// Streaming event buffer — accumulates events between flushes to reduce re-renders
const eventBuffer = new Map<string, McAgentEvent[]>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/** Move a conversation to the top of the list and update its updatedAt timestamp */
function moveConversationToTop(conversations: McConversation[], id: string): McConversation[] {
  const now = new Date().toISOString();
  return conversations
    .map((c) => (c.id === id ? { ...c, updatedAt: now } : c))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function flushEventBuffer(set: (fn: (s: ChatState) => Partial<ChatState>) => void): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (eventBuffer.size === 0) return;
  const entries = Array.from(eventBuffer.entries());
  eventBuffer.clear();
  set((s) => {
    const updated = { ...s.streamingEvents };
    for (const [id, buffered] of entries) {
      updated[id] = [...(updated[id] ?? []), ...buffered];
    }
    return { streamingEvents: updated };
  });
}

export const useChatStore = create<ChatState>((set, get) => ({
  conversations: [],
  selectedConversationId: null,
  messages: {},
  streamingEvents: {},
  sending: {},
  unreadConversations: new Set(),

  async loadConversations() {
    const conversations = await window.api.chatListConversations();
    conversations.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    set({ conversations });
  },

  async loadAllConversations() {
    const conversations = await window.api.chatListConversations();
    conversations.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    set({ conversations });
  },

  async selectConversation(id: string) {
    const unread = new Set(get().unreadConversations);
    unread.delete(id);
    set({ selectedConversationId: id, unreadConversations: unread });
    if (!get().messages[id]) {
      const messages = await window.api.chatGetMessages(id);
      set((s) => ({ messages: { ...s.messages, [id]: messages } }));
    }
  },

  async createConversation(agentId: string) {
    const conversation = await window.api.chatCreateConversation(agentId);
    set((s) => ({
      conversations: [conversation, ...s.conversations],
      messages: { ...s.messages, [conversation.id]: [] },
    }));
    return conversation;
  },

  async renameConversation(id: string, title: string) {
    await window.api.chatRenameConversation(id, title);
    set((s) => ({
      conversations: moveConversationToTop(
        s.conversations.map((c) => (c.id === id ? { ...c, title } : c)),
        id,
      ),
    }));
  },

  async deleteConversation(id: string) {
    await window.api.chatDeleteConversation(id);
    set((s) => {
      const { [id]: _m, ...restMessages } = s.messages;
      const { [id]: _se, ...restEvents } = s.streamingEvents;
      const { [id]: _s, ...restSending } = s.sending;
      const unread = new Set(s.unreadConversations);
      unread.delete(id);
      return {
        conversations: s.conversations.filter((c) => c.id !== id),
        selectedConversationId: s.selectedConversationId === id ? null : s.selectedConversationId,
        messages: restMessages,
        streamingEvents: restEvents,
        sending: restSending,
        unreadConversations: unread,
      };
    });
  },

  async sendMessage(
    conversationId: string,
    text: string,
    images?: { mediaType: string; data: string }[],
  ) {
    // Optimistic user message for instant UI feedback
    const userMsg: McMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: { type: 'user', text, ...(images?.length ? { images } : {}) },
      timestamp: new Date().toISOString(),
    };
    set((s) => ({
      conversations: moveConversationToTop(s.conversations, conversationId),
      messages: {
        ...s.messages,
        [conversationId]: [...(s.messages[conversationId] ?? []), userMsg],
      },
      streamingEvents: { ...s.streamingEvents, [conversationId]: [] },
      sending: { ...s.sending, [conversationId]: true },
    }));
    try {
      await window.api.chatSend(conversationId, text, images);
    } catch (err) {
      // Optimistic user message is kept — user can see what they sent and retry
      set((s) => ({ sending: { ...s.sending, [conversationId]: false } }));
      throw err;
    }
  },

  cancelMessage(conversationId: string) {
    window.api.chatCancel(conversationId);
    set((s) => ({ sending: { ...s.sending, [conversationId]: false } }));
  },

  appendStreamingEvent(conversationId: string, event: McAgentEvent) {
    // Buffer events and flush every ~100ms to avoid per-character re-renders
    if (!eventBuffer.has(conversationId)) {
      eventBuffer.set(conversationId, []);
    }
    eventBuffer.get(conversationId)?.push(event);

    if (!flushTimer) {
      flushTimer = window.setTimeout(() => {
        flushTimer = null;
        flushEventBuffer(set);
      }, 100);
    }
  },

  finalizeMessage(conversationId: string) {
    // Flush any buffered events before finalizing
    flushEventBuffer(set);
    const state = get();
    const events = state.streamingEvents[conversationId] ?? [];
    const assistantMsg: McMessage = {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: { type: 'assistant', events: events as Record<string, unknown>[] },
      timestamp: new Date().toISOString(),
    };
    // Mark as unread if this conversation is not currently selected
    const unread =
      state.selectedConversationId !== conversationId
        ? new Set([...state.unreadConversations, conversationId])
        : state.unreadConversations;
    set((s) => ({
      conversations: moveConversationToTop(s.conversations, conversationId),
      messages: {
        ...s.messages,
        [conversationId]: [...(s.messages[conversationId] ?? []), assistantMsg],
      },
      streamingEvents: { ...s.streamingEvents, [conversationId]: [] },
      sending: { ...s.sending, [conversationId]: false },
      unreadConversations: unread,
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
      conversations: moveConversationToTop(s.conversations, conversationId),
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

  window.api.onAgentEvent((conversationId, event) => {
    useChatStore.getState().appendStreamingEvent(conversationId, event);
  });
  window.api.onChatDone((conversationId) => {
    useChatStore.getState().finalizeMessage(conversationId);
  });
  window.api.onChatError((conversationId, error) => {
    useChatStore.getState().setMessageError(conversationId, error);
  });
}
