import type {
  ConversationMessage,
  ConversationSummary,
  MobileWsClientFrame,
  MobileWsServerFrame,
} from '@dash/mobile-contract';
import { create } from 'zustand';
import type { StoreApi, UseBoundStore } from 'zustand';
import type { ChatSocket, FrameHandler } from '../api/chat-socket';
import type { MobileRestClient } from '../api/rest';
import { type Transcript, applyServerFrame } from './assemble';

export interface WebAppState {
  conversations: ConversationSummary[];
  transcripts: Record<string, Transcript>;
  connection: 'connected' | 'reconnecting' | 'offline';
  loadConversations(): Promise<void>;
  openConversation(id: string): Promise<void>;
  sendMessage(conversationId: string, text: string): Promise<void>;
}

export interface WebAppStoreDeps {
  rest: MobileRestClient;
  socketFactory: (
    onFrame: FrameHandler,
    onClose: (reason: 'error' | 'closed') => void,
  ) => ChatSocket;
}

/**
 * Exponential backoff for WS reconnect attempts: 1s, 2s, 4s, 8s, 16s, capped
 * at 30s. Exported so tests can drive `vi.advanceTimersByTimeAsync` off the
 * same constants rather than hard-coding them. Mirrors the reconnect curve
 * already used by Mission Control's `ResumableChatTransport`
 * (`apps/mission-control/src/main/resumable-chat-transport.ts`).
 */
export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_FACTOR = 2;
export const RECONNECT_MAX_MS = 30_000;

function reconnectDelay(attempt: number): number {
  return Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * RECONNECT_FACTOR ** attempt);
}

/** Channel identifier this browser client identifies itself with on `ChatSend` frames. */
const CHANNEL_ID = 'web';

function emptyTranscript(): Transcript {
  return { messages: [], streaming: null };
}

/** Merges by message `id`; `incoming` (freshly fetched via REST) wins on
 * conflict since it reflects the server's authoritative state. Result is
 * sorted by `ordinal` so replayed/reconciled pages always read chronologically. */
function mergeMessagesById(
  existing: ConversationMessage[],
  incoming: ConversationMessage[],
): ConversationMessage[] {
  const byId = new Map<string, ConversationMessage>();
  for (const m of existing) byId.set(m.id, m);
  for (const m of incoming) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => a.ordinal - b.ordinal);
}

/**
 * Conversation store: streaming assembly (via `assemble.ts`) plus REST
 * replay/reconnect. Built on zustand v5's `create` (the React-hook flavor,
 * not `zustand/vanilla`) since its return type — `UseBoundStore<StoreApi<T>>`
 * — is exactly the shape the brief specifies; no separate vanilla-store +
 * `useStore` adapter is needed for that reason. Non-reactive plumbing
 * (the live socket, reconnect timer/attempt count, which conversation is
 * open) lives in closure variables rather than store state — it's wiring,
 * not UI-observable data.
 */
export function createWebAppStore(deps: WebAppStoreDeps): UseBoundStore<StoreApi<WebAppState>> {
  const { rest, socketFactory } = deps;

  let currentConversationId: string | null = null;
  let socket: ChatSocket | null = null;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let intentionalClose = false;

  /** Backward-paginated replay: `getMessages` walks from newest to oldest via
   * `before` cursors (see rest.ts), so pages are accumulated oldest-first
   * before flattening to produce a chronological list. */
  async function fetchAllMessages(conversationId: string): Promise<ConversationMessage[]> {
    const pages: ConversationMessage[][] = [];
    let cursor: string | undefined;
    do {
      const page = await rest.getMessages(conversationId, cursor);
      pages.unshift(page.items);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return pages.flat();
  }

  return create<WebAppState>((set, get) => {
    function updateTranscript(
      conversationId: string,
      updater: (t: Transcript) => Transcript,
    ): void {
      set((state) => ({
        transcripts: {
          ...state.transcripts,
          [conversationId]: updater(state.transcripts[conversationId] ?? emptyTranscript()),
        },
      }));
    }

    function handleFrame(frame: MobileWsServerFrame): void {
      const frameConversationId = 'conversationId' in frame ? frame.conversationId : undefined;
      const conversationId = frameConversationId ?? currentConversationId;
      if (!conversationId) return;

      if (frame.type === 'error') {
        // Surfaced against the conversation itself; assemble.ts leaves the
        // transcript (messages/streaming) untouched for `error` frames so
        // partially-streamed content is never discarded.
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === conversationId
              ? { ...c, status: 'interrupted', lastMessagePreview: frame.error }
              : c,
          ),
        }));
      }

      updateTranscript(conversationId, (t) => {
        // The client-chosen turn id (sent as `id` on the ChatSend frame) is
        // what the optimistic user message was tagged with as `turnId`
        // (see sendMessage); reconcile it to the server-assigned
        // `userMessageId` now that the turn has been accepted.
        const reconciled: Transcript =
          frame.type === 'accepted'
            ? {
                ...t,
                messages: t.messages.map((m) =>
                  m.role === 'user' && m.turnId === frame.id
                    ? { ...m, id: frame.userMessageId, status: 'completed' as const }
                    : m,
                ),
              }
            : t;
        return applyServerFrame(reconciled, frame);
      });
    }

    function scheduleReconnect(): void {
      if (reconnectTimer || !currentConversationId) return;
      const delay = reconnectDelay(reconnectAttempt);
      reconnectAttempt += 1;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        void attemptReconnect();
      }, delay);
    }

    async function attemptReconnect(): Promise<void> {
      const conversationId = currentConversationId;
      if (!conversationId) return;
      const fresh = socketFactory(handleFrame, handleClose);
      socket = fresh;
      try {
        await fresh.connect();
      } catch {
        scheduleReconnect();
        return;
      }
      reconnectAttempt = 0;
      set({ connection: 'connected' });

      // Reconcile: re-fetch messages and merge by id so nothing sent/updated
      // while disconnected is lost, and nothing already known is duplicated.
      const messages = await fetchAllMessages(conversationId);
      updateTranscript(conversationId, (t) => ({
        ...t,
        messages: mergeMessagesById(t.messages, messages),
      }));
    }

    function handleClose(reason: 'error' | 'closed'): void {
      if (intentionalClose) {
        intentionalClose = false;
        return;
      }
      void reason; // Both reasons trigger a reconnect; only a store-initiated close skips it.
      set({ connection: 'reconnecting' });
      scheduleReconnect();
    }

    return {
      conversations: [],
      transcripts: {},
      connection: 'offline',

      async loadConversations() {
        const page = await rest.listConversations();
        set({ conversations: page.items });
      },

      async openConversation(conversationId: string) {
        if (socket) {
          intentionalClose = true;
          socket.close();
          socket = null;
        }
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        reconnectAttempt = 0;
        currentConversationId = conversationId;

        const messages = await fetchAllMessages(conversationId);
        updateTranscript(conversationId, (t) => ({ ...t, messages }));

        const fresh = socketFactory(handleFrame, handleClose);
        socket = fresh;
        await fresh.connect();
        set({ connection: 'connected' });
      },

      async sendMessage(conversationId: string, text: string) {
        if (!socket) {
          throw new Error('No active chat socket: call openConversation() first');
        }
        const conversation = get().conversations.find((c) => c.id === conversationId);
        if (!conversation) {
          throw new Error(`Unknown conversation: ${conversationId}`);
        }

        const turnId = crypto.randomUUID();
        const optimistic: ConversationMessage = {
          id: turnId,
          conversationId,
          turnId,
          ordinal: (get().transcripts[conversationId]?.messages.length ?? 0) + 1,
          role: 'user',
          status: 'accepted',
          content: { type: 'user', text },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        updateTranscript(conversationId, (t) => ({
          ...t,
          messages: [...t.messages, optimistic],
        }));

        const frame: MobileWsClientFrame = {
          type: 'message',
          id: turnId,
          agentId: conversation.agentId,
          channelId: CHANNEL_ID,
          conversationId,
          text,
          resumable: true,
        };
        socket.send(frame);
      },
    };
  });
}
