import type {
  ConversationMessage,
  ConversationSummary,
  MobileAgent,
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
   * `'idle'` is the store's INITIAL state — before any conversation has ever
   * been opened or reconnect has ever been attempted. It means "nothing has
   * gone wrong yet," not "the gateway is unreachable": a healthy account
   * with zero conversations (so nothing ever calls `openConversation()`)
   * stays `'idle'` forever, and consumers (`ChatView`'s unreachable banner,
   * `ConversationList`'s empty-state copy) must not treat it as an outage.
   * `'offline'` is reserved for the two outage cases that actually earned
   * it: the reconnect-attempt cap exhausting (`finalizeReconnectExhausted`)
   * or that probe confirming the gateway is genuinely unreachable — never
   * the starting point.
   *
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
  connection: 'idle' | 'connected' | 'reconnecting' | 'offline' | 'unauthorized';
  /**
   * Fetches the account's registered agents (`GET /agents`), un-cached and
   * un-stored on this state — callers like `ConversationList`'s "New
   * conversation" flow just need the list transiently to build an agent
   * picker (or skip straight past it when there's exactly one).
   */
  listAgents(): Promise<MobileAgent[]>;
  /**
   * Creates a conversation via REST (`rest.createConversation`, a fresh
   * `requestId` per call), prepends the result to `conversations` so
   * `sendMessage`'s `conversations.find(...)` lookup can resolve it without
   * a separate `loadConversations()` round-trip, then opens it exactly like
   * `openConversation(id)` would. Any REST failure (network, non-2xx)
   * propagates to the caller rather than being swallowed into a `connection`
   * state — unlike `loadConversations`/`openConversation`, a failed *create*
   * isn't a transport/credential problem the store itself should reinterpret,
   * it's an action the UI asked for that didn't happen and must say so.
   */
  startConversation(agentId: string, title?: string): Promise<ConversationSummary>;
  loadConversations(): Promise<void>;
  openConversation(id: string): Promise<void>;
  sendMessage(conversationId: string, text: string): Promise<void>;
  /**
   * Message actions (chat-ux Phase 2 Task 4, audit #5): retry-failed and
   * edit-and-resend both funnel through here — retry is a call with no
   * `editedText`. Semantics (binding across web and iOS, see
   * `ios/Dash/Features/Conversations/ChatFeature.swift`'s
   * `resendFromMessage`): truncate the LOCAL transcript to everything
   * BEFORE the target user message (dropping it and everything after —
   * including whatever assistant reply, failed or not, followed it), then
   * send `editedText ?? that message's own text` through the existing
   * `sendMessage` path. `messageId` must belong to a `role: 'user'` message
   * currently in `transcripts[conversationId].messages`; anything else
   * (unknown id, an assistant message id) is a no-op.
   *
   * KNOWN DIVERGENCE: this only ever truncates the LOCAL projection. The
   * gateway has no branch-truncation API — resending appends a brand-new
   * turn server-side, so the previously-sent (now locally-hidden) turn
   * still exists in the server's history and would reappear on a future
   * REST replay that starts before this edit (e.g. reopening the
   * conversation from scratch, or another device). Full server-side branch
   * truncation, and regenerating an assistant turn in place (as opposed to
   * resending the user turn that produced it), are both out of scope for
   * this task — the latter needs server support this gateway doesn't have.
   *
   * ALSO a no-op while a turn is actively in flight for this conversation
   * (`transcripts[conversationId].pending` or `.streaming` set) — same
   * precondition iOS's `sendAuthorityIsAvailable` enforces before a resend
   * there (`state.activeTurnID == nil`). `messageId` can belong to a turn
   * EARLIER than the in-flight one (e.g. retrying an older failed message
   * while a newer turn streams); truncating in that case would delete the
   * in-flight turn's own optimistic message out from under it and fire a
   * second, orphaned `sendMessage`. `ChatView`'s toolbar already disables
   * these buttons while streaming, but this guard is enforced here too so
   * it holds regardless of caller — not just the one first-party UI.
   *
   * RETURN VALUE (fix I5): resolves `true` once the resend actually fired
   * (the same success signal `sendMessage`'s resolution implies), `false`
   * for either no-op guard above (in-flight turn, or an unknown/non-user
   * `messageId`) — NEVER throws for those cases, only for the connectivity
   * precondition, which still throws so a genuinely offline resend attempt
   * surfaces the same way `sendMessage` itself does. Callers that let a
   * user hand-edit text before resending (`ChatView`'s `MessageEditor`)
   * MUST check this: on `false` the caller's edited text would otherwise be
   * silently discarded (the editor closing without ever sending it) with no
   * indication anything went wrong.
   */
  resendFromMessage(
    conversationId: string,
    messageId: string,
    editedText?: string,
  ): Promise<boolean>;
  /**
   * Cancels the in-flight turn for `conversationId` by sending a WS `cancel`
   * frame (`{ type: 'cancel', id: <turnId> }`) — the same gateway route
   * Mission Control's `cancelMessage` and the iOS client's `ChatFeature.cancel`
   * use (`apps/gateway/src/chat-ws.ts` handles `msg.type === 'cancel'` by
   * aborting the turn keyed on `msg.id`, the turn id, not the conversation
   * id). The turn id comes from `Transcript.pending.turnId`, set once the
   * `accepted` frame lands (see `assemble.ts`) — so this is a no-op before a
   * turn has been accepted, once it's already finished, or if `conversationId`
   * isn't the conversation this store's live socket is currently attached to.
   * A send failure (e.g. the socket having just dropped) is logged and
   * swallowed rather than thrown: the caller (the composer's stop button)
   * should stay visible until the turn actually ends via a `done`/`error`
   * frame, not flip back to "send" just because the cancel request itself
   * didn't make it out.
   */
  /**
   * Renames a conversation (chat-ux Phase 3 Task 1, audit #8): applies
   * `title` to local state IMMEDIATELY (before the REST round-trip), then
   * calls `rest.patchConversation` (the same `PATCH /mobile/v1/conversations/:id`
   * route with a quoted `If-Match: revision` precondition iOS's
   * `GatewayAPI.patchConversation` uses — see `ConversationListFeature.swift`'s
   * `retryRename`), and reconciles with the server's authoritative summary
   * (new `revision` included) on success.
   *
   * A no-op if `conversationId` isn't in `conversations` (nothing to
   * optimistically rename). On REST failure, rolls the optimistic title back
   * to its prior value; a 401 additionally routes to `enterUnauthorized()`
   * (same "revoked credential" handling as every other REST call in this
   * store) and is swallowed rather than rethrown, but any other failure
   * (network error, validation) propagates to the caller so the UI can show
   * it — same "don't swallow an action the UI asked for" philosophy as
   * `startConversation`.
   *
   * FINAL-REVIEW FIX C1c: a `revision_conflict` (409) — this store's local
   * `revision` is stale, which any turn on this conversation makes routine
   * (the gateway bumps `revision` on `beginTurn`/`finishTurn`; see fix C1a's
   * `accepted`-frame handling and C1b's unconditional done-refresh, which
   * both narrow the window but can't close it entirely — a rename issued in
   * the instant between a turn starting and its `accepted` frame landing can
   * still race) — is handled specially: re-fetch the authoritative summary
   * (`rest.getConversation`) and retry the SAME rename once against its
   * `revision`. Only a second `revision_conflict` (someone else changed it
   * again in that same window) propagates to the caller like any other
   * failure — no reload-required dead end for the common single-conflict
   * case.
   */
  renameConversation(conversationId: string, title: string): Promise<void>;
  /**
   * Deletes a conversation (chat-ux Phase 3 Task 1, audit #8): removes it
   * from `conversations` IMMEDIATELY (before the REST round-trip), then
   * calls `rest.deleteConversation` (the same `DELETE /mobile/v1/conversations/:id`
   * route with a quoted `If-Match: revision` precondition iOS's
   * `GatewayAPI.deleteConversation` uses — see `ConversationListFeature.swift`'s
   * `retryDelete`).
   *
   * A no-op if `conversationId` isn't in `conversations`. On REST failure,
   * restores the removed row and rethrows (except a 401, which routes to
   * `enterUnauthorized()` instead, same as every other REST call here).
   *
   * FINAL-REVIEW FIX C1c: same `revision_conflict` (409) retry-once handling
   * as `renameConversation` — see its doc comment — re-fetches the
   * authoritative summary and retries the delete once against its
   * `revision` before giving up and surfacing the error.
   *
   * If the deleted conversation is the one this store's live socket is
   * currently attached to (`openConversation`'s target), the socket is torn
   * down and `connection` resets to `'idle'` — there is nothing left to
   * stream into. This only tears down the STORE's own connection state; it
   * is the caller's job (`ConversationList`/`Shell`) to also clear whatever
   * UI-level "selected conversation" state pointed at the now-deleted id, so
   * `ChatView` stops being handed a dead `conversationId` — see `ChatView`'s
   * `conversationId={null}` empty state, which this store's `connection:
   * 'idle'` reset is deliberately compatible with (unlike `'offline'`, which
   * `ChatView` renders as an unreachable-gateway banner regardless of
   * `conversationId`).
   */
  deleteConversation(conversationId: string): Promise<void>;
  cancelTurn(conversationId: string): void;
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

/**
 * True for a `revision_conflict` (409) `MobileApiError` — this store's
 * local `revision` for a conversation (used as the `If-Match` precondition
 * on `renameConversation`/`deleteConversation`) is stale relative to the
 * gateway's. Final-review fix C1c: rather than dead-ending the user on a
 * "reload the page" error, both mutations catch exactly this and retry once
 * against a freshly-fetched `revision` — see their doc comments.
 */
function isRevisionConflict(err: unknown): boolean {
  return err instanceof MobileApiError && err.code === 'revision_conflict';
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

    /**
     * Summary refresh on turn completion (chat-ux Phase 3 Task 1, audit #8;
     * widened by final-review fix C1b): the gateway generates a
     * conversation's title in the background starting from its FIRST
     * accepted user message (`apps/gateway/src/resumable-chat-hub.ts`'s
     * `autoTitle.schedule`, fired in parallel with the turn itself, not
     * gated on it finishing) — there's no push notification of that title
     * (or of `lastMessagePreview`, or of `revision`) landing on this store's
     * WS connection, so once a turn COMPLETES (`done` frame) this
     * unconditionally re-fetches that one summary. Originally gated on the
     * local title still being the gateway's default (the literal
     * `'New Conversation'`, `apps/gateway/src/conversation-service.ts`'s
     * `DEFAULT_CONVERSATION_TITLE`) — narrowly aimed at the auto-title case —
     * but that guard left
     * `lastMessagePreview` and `revision` stale on every OTHER turn (a
     * second message in an already-titled conversation never refreshed
     * either), and `revision` staleness is exactly what makes a
     * rename/delete issued right after a turn 409 with `revision_conflict`
     * (see `renameConversation`/`deleteConversation`'s retry-once handling)
     * — dropping the guard fixes both by keeping every turn-completion
     * refresh unconditional. Best-effort and silent on failure (this isn't a
     * user-initiated action, so nothing here shows an error) EXCEPT a 401,
     * which still means "this credential is dead" and routes to
     * `enterUnauthorized()` same as every other REST call in this store.
     * Fetches a single conversation (`rest.getConversation`), not the whole
     * list, so a concurrent optimistic rename/delete of some OTHER
     * conversation in `conversations` can't be clobbered by a stale full-list
     * refetch racing it.
     */
    function maybeRefreshAutoTitle(conversationId: string): void {
      const conversation = get().conversations.find((c) => c.id === conversationId);
      if (!conversation) return;
      // Phase 4 Task 6: remember the title this refresh started from. If the
      // user optimistically renames while the fetch is in flight, the (older)
      // summary that comes back must not overwrite their title — the rename's
      // own PATCH response is what settles it. Best-effort refresh loses.
      const titleAtRefreshStart = conversation.title;
      rest
        .getConversation(conversationId)
        .then((updated) => {
          set((state) => ({
            conversations: state.conversations.map((c) =>
              c.id === conversationId && c.title === titleAtRefreshStart ? updated : c,
            ),
          }));
        })
        .catch((err: unknown) => {
          if (isAuthError(err)) {
            enterUnauthorized();
          }
        });
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

      // Final-review fix C1a: the gateway bumps a conversation's `revision`
      // on both `beginTurn` and `finishTurn` (server-side, no push outside
      // this WS frame), and the `accepted` frame is the one place that
      // revision rides along for free (`MobileWsServerFrame`'s `accepted`
      // variant, contracts/mobile/v1 types.ts). Applying it to the summary
      // here — as soon as it's accepted, not waiting for `done` — keeps
      // `renameConversation`/`deleteConversation`'s `If-Match` precondition
      // from going stale the moment ANY turn runs on this conversation
      // (previously only a full `getConversation`/`listConversations`
      // refetch ever updated `revision`, so a rename/delete issued after a
      // turn reliably 409'd with `revision_conflict` even before the retry
      // handling below).
      if (frame.type === 'accepted') {
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === conversationId ? { ...c, revision: frame.revision } : c,
          ),
        }));
      }

      // Summary refresh (chat-ux Phase 3 Task 1, audit #8; widened by
      // final-review fix C1b): a turn just finished — see
      // `maybeRefreshAutoTitle`'s doc comment for why `done` (not
      // `accepted`, which fires before the gateway's title generation has
      // had any time to run) is the trigger.
      if (frame.type === 'done') {
        maybeRefreshAutoTitle(conversationId);
      }
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
      connection: 'idle',

      async listAgents() {
        return rest.listAgents();
      },

      async startConversation(agentId: string, title?: string) {
        const created = await rest.createConversation({
          agentId,
          requestId: crypto.randomUUID(),
          title,
        });
        set((state) => ({ conversations: [created, ...state.conversations] }));
        await get().openConversation(created.id);
        return created;
      },

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
        // Reset BEFORE the replay attempt, not after it succeeds: `lastSeq`
        // is a single per-store closure variable, not keyed by conversation.
        // Switching from conversation A (replay succeeded, lastSeq = N) to
        // conversation B whose own replay then fails would otherwise leave
        // `lastSeq` holding A's cursor — and the non-auth-failure path below
        // schedules a reconnect that resumes *this* (B's) conversation via
        // `attemptReconnect`'s `sinceSeq: lastSeq`. Sending B's gateway A's
        // cursor would desync the resume (wrong/missing history, or the
        // gateway rejecting an out-of-range `sinceSeq` for a conversation it
        // never saw at that seq) — B would then look like it silently
        // replays nothing, forever, without a fresh full replay to recover.
        // A successful replay overwrites this with the real value below;
        // this is only ever observed if that never happens.
        lastSeq = 0;

        let replay: { messages: ConversationMessage[]; lastSeq: number };
        try {
          replay = await replayHistory(conversationId);
        } catch (err) {
          if (disposed) return;
          if (isAuthError(err)) {
            enterUnauthorized();
            return;
          }
          // A gateway that is unreachable during the initial history replay
          // is not a programming error, any more than a failed socket
          // `connect()` is (see the identical handling further down) — and
          // the only caller is a React effect, so rethrowing here would
          // surface as an unhandled rejection and leave `connection` stuck
          // wherever it was. That "wherever it was" matters more now that
          // `'idle'` is the initial value: a fresh store whose very first
          // `openConversation()` call fails this replay would otherwise be
          // stranded on `'idle'` forever — no banner, no reconnecting
          // indicator, no retry ever scheduled, since nothing else drives
          // this store's state machine. Treat it exactly like a socket that
          // drops later: report the outage and retry on the normal backoff
          // schedule; if it's a genuine outage the reconnect machinery's own
          // probe (`finalizeReconnectExhausted`) is what eventually lands on
          // `'offline'`.
          set({ connection: 'reconnecting' });
          scheduleReconnect();
          return;
        }
        // `dispose()` can land while the replay round-trip is in flight. Without
        // this check we would go on to open a socket the store no longer owns
        // and never closes — `haltReconnectMachinery` has already run and only
        // tears down the socket that existed when it did.
        if (disposed) return;
        lastSeq = replay.lastSeq;
        updateTranscript(conversationId, (t) => ({
          ...t,
          messages: mergeMessagesById(t.messages, replay.messages),
        }));

        const attached = createAttachedSocket();
        socket = attached;
        try {
          await attached.connect();
        } catch (err) {
          if (socket === attached) socket = null;
          attached.close();
          if (disposed) return;
          if (isAuthError(err)) {
            enterUnauthorized();
            return;
          }
          // A gateway that is simply unreachable is not a programming error, and
          // the only caller is a React effect — rejecting there would surface as
          // an unhandled rejection and leave `connection` stuck on its previous
          // value. Treat it exactly like a socket that drops later: report the
          // outage and retry on the normal backoff schedule.
          set({ connection: 'reconnecting' });
          scheduleReconnect();
          return;
        }
        // Same race as above, on the far side of the connect round-trip.
        if (disposed) {
          if (socket === attached) socket = null;
          attached.close();
          return;
        }
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

      async resendFromMessage(conversationId, messageId, editedText) {
        // Same connected-socket precondition `sendMessage` itself enforces
        // (and the composer's `canSend` gate already keeps the UI from
        // reaching this button while disconnected) — checked BEFORE
        // truncating so a resend attempted while offline throws without
        // discarding any local history.
        if (!socket || get().connection !== 'connected') {
          throw new Error(
            'Cannot resend: no connected chat socket (call openConversation() and wait for it to connect)',
          );
        }
        const transcript = get().transcripts[conversationId];
        // A turn is in flight for this conversation (accepted, mid-stream,
        // or awaiting its first event) — never truncate/resend underneath
        // it, regardless of which message `messageId` names. See the doc
        // comment on this method for why. Returns `false` (fix I5), not a
        // silent `undefined` — callers with user-edited text in hand need
        // to tell "guarded, nothing happened" apart from "sent".
        if (transcript?.pending || transcript?.streaming) return false;
        const index =
          transcript?.messages.findIndex((m) => m.id === messageId && m.role === 'user') ?? -1;
        if (!transcript || index === -1) return false;
        const target = transcript.messages[index];
        const text = editedText ?? (target.content.type === 'user' ? target.content.text : '');

        updateTranscript(conversationId, (t) => ({
          ...t,
          messages: t.messages.slice(0, index),
        }));

        await get().sendMessage(conversationId, text);
        return true;
      },

      async renameConversation(conversationId, title) {
        const previous = get().conversations;
        const target = previous.find((c) => c.id === conversationId);
        if (!target) return;

        set({
          conversations: previous.map((c) => (c.id === conversationId ? { ...c, title } : c)),
        });
        try {
          let updated: ConversationSummary;
          try {
            updated = await rest.patchConversation(conversationId, { title }, target.revision);
          } catch (err) {
            // Fix C1c: stale local `revision` — refetch and retry ONCE
            // before giving up. Anything other than `revision_conflict`
            // (network error, 401, validation) falls straight through to
            // the outer catch, same as before this fix.
            if (!isRevisionConflict(err)) throw err;
            const fresh = await rest.getConversation(conversationId);
            updated = await rest.patchConversation(conversationId, { title }, fresh.revision);
          }
          set((state) => ({
            conversations: state.conversations.map((c) => (c.id === conversationId ? updated : c)),
          }));
        } catch (err) {
          set({ conversations: previous });
          if (isAuthError(err)) {
            enterUnauthorized();
            return;
          }
          throw err;
        }
      },

      async deleteConversation(conversationId) {
        const previous = get().conversations;
        const target = previous.find((c) => c.id === conversationId);
        if (!target) return;

        set({ conversations: previous.filter((c) => c.id !== conversationId) });
        try {
          try {
            await rest.deleteConversation(conversationId, target.revision);
          } catch (err) {
            // Fix C1c: same stale-`revision` retry-once as renameConversation.
            if (!isRevisionConflict(err)) throw err;
            const fresh = await rest.getConversation(conversationId);
            await rest.deleteConversation(conversationId, fresh.revision);
          }
        } catch (err) {
          set({ conversations: previous });
          if (isAuthError(err)) {
            enterUnauthorized();
            return;
          }
          throw err;
        }
        if (conversationId === currentConversationId) {
          haltReconnectMachinery();
          set({ connection: 'idle' });
        }
      },

      cancelTurn(conversationId) {
        if (!socket || conversationId !== currentConversationId) return;
        const turnId = get().transcripts[conversationId]?.pending?.turnId;
        if (!turnId) return;
        const frame: MobileWsClientFrame = { type: 'cancel', id: turnId };
        try {
          socket.send(frame);
        } catch (err) {
          console.error('WebAppStore: failed to send cancel frame', err);
        }
      },

      dispose() {
        haltReconnectMachinery();
        // A teardown-terminal value, not an outage report: by the time this
        // runs the store is being discarded (Shell nulls out the store on
        // gateway switch/self-revocation/unmount — see Shell.tsx's teardown
        // effect), so no UI ever reads `connection` off a disposed store
        // afterwards. `'offline'` (over introducing yet another state just
        // for this) is fine precisely because it's unobserved.
        set({ connection: 'offline' });
      },
    };
  });
}
