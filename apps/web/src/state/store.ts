import type {
  ConversationMessage,
  ConversationSummary,
  MobileWsClientFrame,
  MobileWsServerFrame,
} from '@dash/mobile-contract';
import { create } from 'zustand';
import type { StoreApi, UseBoundStore } from 'zustand';
import type { ChatSocket, FrameHandler } from '../api/chat-socket';
import { MobileApiError, type MobileRestClient } from '../api/rest';
import { type Transcript, applyServerFrame } from './assemble';

export interface WebAppState {
  conversations: ConversationSummary[];
  transcripts: Record<string, Transcript>;
  /**
   * `'unauthorized'` is terminal, same spirit as `'offline'` but for a
   * *credential* problem rather than a *transport* one: the gateway's own
   * `chatToken` or this browser's relay credential was rejected (401) —
   * remotely revoked from another device/Mission Control, most commonly.
   * Design doc (`docs/plans/2026-08-29-web-interface-design.md`, Error
   * Handling): "revoked/rejected credential → GatewayPicker with
   * explanation. Never a silent retry loop on auth failures." — so unlike
   * `'reconnecting'`/`'offline'`, nothing in this store ever retries out of
   * `'unauthorized'` on its own; see `enterUnauthorized`/`isAuthError`.
   */
  connection: 'connected' | 'reconnecting' | 'offline' | 'unauthorized';
  loadConversations(): Promise<void>;
  openConversation(id: string): Promise<void>;
  sendMessage(conversationId: string, text: string): Promise<void>;
  /**
   * Tears down this store's live connection: closes the current socket (if
   * any), cancels any pending reconnect timer, and stops any reconnect
   * attempt already in flight from resurrecting a connection afterwards.
   * Sets `connection` to `'offline'`. For when the *store itself* is being
   * abandoned — e.g. `Shell` dropping back to `'pick-gateway'` after this
   * browser's own pairing was revoked — not for an in-app "close this
   * conversation" action (that's just `openConversation()` with a different
   * id, which already detaches the previous socket). A disposed store can
   * still be reused: `openConversation()` clears the disposed flag, same as
   * it already resets the reconnect-attempt counter.
   */
  dispose(): void;
}

export interface WebAppStoreDeps {
  rest: MobileRestClient;
  socketFactory: (
    onFrame: FrameHandler,
    onClose: (reason: 'error' | 'closed') => void,
  ) => ChatSocket;
  /** Overrides for the reconnect policy; both are test/consumer hooks — the
   * defaults (below) are what production code gets. */
  reconnect?: {
    /** Give up and transition to `'offline'` after this many failed
     * attempts. Defaults to `RECONNECT_MAX_ATTEMPTS`. */
    maxAttempts?: number;
  };
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
/** Default cap on reconnect attempts before giving up and going `'offline'`
 * (≈1+2+4+8+16+30 ≈ 61s of retrying). A subsequent `openConversation()` call
 * (e.g. from a UI "retry" action) resets the counter and starts over. */
export const RECONNECT_MAX_ATTEMPTS = 6;

function reconnectDelay(attempt: number): number {
  return Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * RECONNECT_FACTOR ** attempt);
}

/**
 * True for a 401 from any mobile-v1 REST call — the gateway rejecting this
 * browser's `chatToken`, or (just as often in practice) the *relay* itself
 * rejecting a revoked relay credential before the request ever reaches the
 * gateway. The latter comes back as a plain-text "Unauthorized" body rather
 * than the gateway's structured `{ code, error, retryable }` JSON —
 * `MobileApiError`'s `code` is `undefined` in that case (see
 * `readErrorCode`'s catch in `api/rest.ts`) — but the status is still 401,
 * which is all this checks: both cases mean the same thing to this store,
 * "this credential is dead," and get the same treatment.
 */
function isAuthError(err: unknown): boolean {
  return err instanceof MobileApiError && err.status === 401;
}

/** Channel identifier this browser client identifies itself with on outgoing frames. */
const CHANNEL_ID = 'web';

function emptyTranscript(): Transcript {
  return { messages: [], streaming: null };
}

/**
 * Merges by message `id`; `incoming` (freshly fetched via REST) wins on
 * conflict since it reflects the server's authoritative state. Also drops
 * any *local* message whose `turnId` matches an incoming message under a
 * *different* id — that's the optimistic stand-in for a turn the server has
 * since assigned a real id to (e.g. a `sendMessage` call whose `accepted`
 * frame hadn't arrived yet when this merge ran); keeping both would produce
 * a permanent duplicate. Result is sorted by `ordinal` so replayed/merged
 * pages always read chronologically.
 */
function mergeMessagesById(
  existing: ConversationMessage[],
  incoming: ConversationMessage[],
): ConversationMessage[] {
  const byId = new Map<string, ConversationMessage>();
  for (const m of existing) byId.set(m.id, m);

  const incomingTurnIds = new Set(incoming.map((m) => m.turnId));
  const incomingIds = new Set(incoming.map((m) => m.id));
  for (const [id, m] of byId) {
    if (incomingTurnIds.has(m.turnId) && !incomingIds.has(id)) {
      byId.delete(id);
    }
  }

  for (const m of incoming) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => a.ordinal - b.ordinal);
}

/**
 * Conversation store: streaming assembly (via `assemble.ts`) plus REST
 * replay and WS resume-based reconnect. Built on zustand v5's `create` (the
 * React-hook flavor, not `zustand/vanilla`) since its return type —
 * `UseBoundStore<StoreApi<T>>` — is exactly the shape the brief specifies;
 * no separate vanilla-store + `useStore` adapter is needed for that reason.
 * Non-reactive plumbing (the live socket, reconnect timer/attempt count,
 * the last-seen seq, which conversation is open) lives in closure variables
 * rather than store state — it's wiring, not UI-observable data.
 */
export function createWebAppStore(deps: WebAppStoreDeps): UseBoundStore<StoreApi<WebAppState>> {
  const { rest, socketFactory } = deps;
  const maxReconnectAttempts = deps.reconnect?.maxAttempts ?? RECONNECT_MAX_ATTEMPTS;

  let currentConversationId: string | null = null;
  let socket: ChatSocket | null = null;
  let lastSeq = 0;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set by `dispose()`; checked at every point that would otherwise
   * (re)establish a connection or resurrect `connection` out of `'offline'`
   * — see `scheduleReconnect`/`attemptReconnect` — so a reconnect already in
   * flight when `dispose()` runs can't undo it. Cleared by `openConversation`
   * so a disposed store remains reusable. */
  let disposed = false;

  function clearReconnectTimer(): void {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  /** Backward-paginated replay: `getMessages` walks from newest to oldest via
   * `before` cursors (see rest.ts), so pages are accumulated oldest-first
   * before flattening to produce a chronological list. The newest (first)
   * page's `throughSeq` becomes the resume baseline — everything up to it is
   * already reflected in `messages`. This is the *initial* load only: after
   * a mid-session drop, reconnect resumes from `lastSeq` over the socket
   * instead of re-walking history (see `attemptReconnect`). */
  async function replayHistory(
    conversationId: string,
  ): Promise<{ messages: ConversationMessage[]; lastSeq: number }> {
    const pages: ConversationMessage[][] = [];
    let cursor: string | undefined;
    let throughSeq = 0;
    let first = true;
    do {
      const page = await rest.getMessages(conversationId, cursor);
      if (first) {
        throughSeq = page.throughSeq;
        first = false;
      }
      pages.unshift(page.items);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return { messages: pages.flat(), lastSeq: throughSeq };
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

    /** Looks up `agentId` for a conversation, refreshing the conversation
     * list once from REST if it isn't already loaded (so `openConversation`
     * never *requires* a prior `loadConversations()` call — see
     * `attemptReconnect`, which needs `agentId` to build a `resume` frame).
     * A 401 is rethrown rather than swallowed into `null`: `attemptReconnect`
     * needs to tell "this credential is dead" apart from "the network call
     * failed for some other reason" so it can go straight to `'unauthorized'`
     * instead of just trying (and failing) the resume again next attempt. */
    async function resolveAgentId(conversationId: string): Promise<string | null> {
      const known = get().conversations.find((c) => c.id === conversationId)?.agentId;
      if (known) return known;
      try {
        const page = await rest.listConversations();
        set({ conversations: page.items });
        return page.items.find((c) => c.id === conversationId)?.agentId ?? null;
      } catch (err) {
        if (isAuthError(err)) throw err;
        return null;
      }
    }

    function handleFrame(frame: MobileWsServerFrame): void {
      const frameConversationId = 'conversationId' in frame ? frame.conversationId : undefined;
      const conversationId = frameConversationId ?? currentConversationId;
      if (!conversationId) return;

      if (conversationId === currentConversationId) {
        const seq = 'seq' in frame ? frame.seq : undefined;
        if (typeof seq === 'number' && seq > lastSeq) lastSeq = seq;
      }

      if (frame.type === 'error') {
        // Surfaced against the conversation and in a dedicated transcript
        // slot; applyServerFrame leaves `messages`/`streaming`/`pending`
        // untouched for `error` frames so partially-streamed content (and
        // the ability to resume it) is never discarded.
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === conversationId ? { ...c, status: 'interrupted' as const } : c,
          ),
        }));
        updateTranscript(conversationId, (t) => ({
          ...t,
          error: {
            message: frame.error,
            code: frame.code,
            retryable: frame.retryable,
            activeTurnId: frame.activeTurnId,
          },
        }));
        return;
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

    /** Wraps a fresh `ChatSocket` so its `onClose` can tell a genuine drop
     * of the *current* socket apart from a late event from one this store
     * itself already detached (e.g. `openConversation` switching to a
     * different conversation). Comparing by identity against the live
     * `socket` variable — captured per-instance here, checked at fire time —
     * means no separate "was this intentional" flag is needed, and so a
     * real drop can never be swallowed by an unrelated close. */
    function createAttachedSocket(): ChatSocket {
      // `created` is referenced inside the `onClose` closure before its own
      // `const` initializer finishes — safe here because that closure only
      // ever runs asynchronously (after `connect()`'s network round-trip),
      // by which point `created` is already initialized.
      const created: ChatSocket = socketFactory(handleFrame, (reason) =>
        onSocketClose(created, reason),
      );
      return created;
    }

    /** Shared teardown for both `dispose()` and `enterUnauthorized()`: closes
     * the live socket (nulling the closure `socket` variable *first*, so the
     * async native-close event that follows can't be misattributed via the
     * identity guard in `createAttachedSocket`/`onSocketClose` — same
     * pattern `openConversation` already relies on when switching
     * conversations), cancels any pending reconnect timer, and sets
     * `disposed` so nothing already in flight (a `scheduleReconnect` call, an
     * in-progress `attemptReconnect`) can resurrect a connection afterwards.
     * Does not touch `connection` itself — callers set their own terminal
     * value. */
    function haltReconnectMachinery(): void {
      disposed = true;
      currentConversationId = null;
      clearReconnectTimer();
      if (socket) {
        const closing = socket;
        socket = null;
        closing.close();
      }
    }

    /** Terminal auth-failure state (design doc, Error Handling: "revoked/
     * rejected credential → GatewayPicker with explanation. Never a silent
     * retry loop on auth failures."). Unlike `'offline'`, nothing in this
     * store ever retries out of `'unauthorized'` on its own — a consumer
     * (`Shell`) must notice it, clear the dead credential, and either drive a
     * fresh `openConversation()` after re-pairing or discard the store via
     * `dispose()`; both already clear `disposed`/tear down cleanly. */
    function enterUnauthorized(): void {
      haltReconnectMachinery();
      set({ connection: 'unauthorized' });
    }

    function onSocketClose(closingSocket: ChatSocket, reason: 'error' | 'closed'): void {
      void reason; // Both reasons mean "this connection is gone" — either warrants a reconnect.
      if (closingSocket !== socket) return; // stale/detached socket — already superseded, ignore.
      socket = null;
      set({ connection: 'reconnecting' });
      scheduleReconnect();
    }

    /** Reached once the reconnect-attempt cap is exhausted. A plain network
     * partition and a remotely-revoked credential look identical from the
     * WS side alone (both just fail to (re)connect), so this probes a cheap
     * authenticated REST call (`identity()`) to tell them apart before
     * settling on a terminal state: 401 means the credential is dead
     * (`'unauthorized'`, and reconnecting stops for good); anything else —
     * including the probe itself failing to reach the gateway — means it's
     * still just offline, matching the design doc's "gateway offline (relay
     * reports no dial) → honest 'gateway unreachable' screen." */
    async function finalizeReconnectExhausted(): Promise<void> {
      if (disposed) return;
      try {
        await rest.identity();
        if (!disposed) set({ connection: 'offline' });
      } catch (err) {
        if (disposed) return;
        if (isAuthError(err)) {
          enterUnauthorized();
        } else {
          set({ connection: 'offline' });
        }
      }
    }

    function scheduleReconnect(): void {
      if (disposed) return;
      if (reconnectTimer || !currentConversationId) return;
      if (reconnectAttempt >= maxReconnectAttempts) {
        void finalizeReconnectExhausted();
        return;
      }
      const delay = reconnectDelay(reconnectAttempt);
      reconnectAttempt += 1;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        void attemptReconnect();
      }, delay);
    }

    /** Resume, not refetch: sends a typed `resume` frame (`sinceSeq:
     * lastSeq`) over the fresh socket so the gateway replays only what was
     * missed, through the existing `handleFrame` → `applyServerFrame` path —
     * no REST history re-walk on the reconnect path. If a turn was
     * in-flight when the connection dropped, its `pending.turnId` is reused
     * as the resume frame's `id` (matching the original turn's
     * correlation id) so replayed `event`/`done` frames finalize it via the
     * same `pending` bookkeeping that was already in the transcript.
     *
     * A 401 anywhere in this attempt — `attempted.connect()`'s own ws-ticket
     * mint (the relay rejecting a revoked relay credential) just as much as
     * `resolveAgentId`'s `listConversations` call — goes straight to
     * `enterUnauthorized()` instead of another `scheduleReconnect()`: no
     * point retrying a credential that's already confirmed dead. */
    async function attemptReconnect(): Promise<void> {
      const conversationId = currentConversationId;
      if (!conversationId || disposed) return;
      const attempted = createAttachedSocket();
      socket = attempted;
      try {
        await attempted.connect();
        if (disposed) {
          // `dispose()` ran while `connect()` was in flight — this
          // connection is unwanted now; tear it straight back down rather
          // than resuming the turn and reporting `'connected'`.
          if (socket === attempted) socket = null;
          attempted.close();
          return;
        }
        const agentId = await resolveAgentId(conversationId);
        if (!agentId) {
          throw new Error(
            `Cannot resume conversation "${conversationId}": agentId is unknown (call loadConversations() first)`,
          );
        }
        const pendingTurnId = get().transcripts[conversationId]?.pending?.turnId;
        const resumeFrame: MobileWsClientFrame = {
          type: 'resume',
          id: pendingTurnId ?? crypto.randomUUID(),
          agentId,
          conversationId,
          sinceSeq: lastSeq,
        };
        attempted.send(resumeFrame);
        reconnectAttempt = 0;
        set({ connection: 'connected' });
      } catch (err) {
        if (socket === attempted) socket = null;
        attempted.close();
        if (disposed) return;
        if (isAuthError(err)) {
          enterUnauthorized();
          return;
        }
        scheduleReconnect();
      }
    }

    return {
      conversations: [],
      transcripts: {},
      connection: 'offline',

      async loadConversations() {
        try {
          const page = await rest.listConversations();
          set({ conversations: page.items });
        } catch (err) {
          if (isAuthError(err)) {
            enterUnauthorized();
            return;
          }
          throw err;
        }
      },

      async openConversation(conversationId: string) {
        if (socket) {
          socket.close();
          socket = null;
        }
        clearReconnectTimer();
        reconnectAttempt = 0;
        disposed = false; // a disposed store is reusable — this is a fresh connect intent.
        currentConversationId = conversationId;

        let replay: { messages: ConversationMessage[]; lastSeq: number };
        try {
          replay = await replayHistory(conversationId);
        } catch (err) {
          if (isAuthError(err)) {
            enterUnauthorized();
            return;
          }
          throw err;
        }
        lastSeq = replay.lastSeq;
        updateTranscript(conversationId, (t) => ({
          ...t,
          messages: mergeMessagesById(t.messages, replay.messages),
        }));

        const attached = createAttachedSocket();
        socket = attached;
        await attached.connect();
        set({ connection: 'connected' });
      },

      async sendMessage(conversationId: string, text: string) {
        if (!socket || get().connection !== 'connected') {
          throw new Error(
            'Cannot send: no connected chat socket (call openConversation() and wait for it to connect)',
          );
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
        try {
          socket.send(frame);
        } catch (err) {
          // Never leave a stuck 'accepted'-status message behind when the
          // send itself failed — mark it failed so the UI can show a retry
          // affordance instead of a message stuck "pending" forever.
          updateTranscript(conversationId, (t) => ({
            ...t,
            messages: t.messages.map((m) =>
              m.id === turnId ? { ...m, status: 'failed' as const } : m,
            ),
          }));
          throw err;
        }
      },

      dispose() {
        haltReconnectMachinery();
        set({ connection: 'offline' });
      },
    };
  });
}
