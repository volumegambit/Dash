import type {
  ConversationMessage,
  ConversationSummary,
  MobileAgent,
  MobileImage,
  MobileWsClientFrame,
  MobileWsServerFrame,
  SubagentListEntry,
} from '@dash/mobile-contract';
import { create } from 'zustand';
import type { StoreApi, UseBoundStore } from 'zustand';
import type { ChatSocket, FrameHandler } from '../api/chat-socket';
import { MobileApiError, type MobileRestClient } from '../api/rest';
import { type Transcript, applyServerFrame } from './assemble';

/**
 * The per-child FACTS half of a {@link SubagentEntry}, as the gateway reports
 * them.
 *
 * Typed as the LIST route's row (`GET /conversations/:id/subagents`) minus its
 * `id`, because two different routes write this field and that shape is what
 * they have in common: the child's own summary (`GET /conversations/:childId`,
 * read by `loadSubagentTranscript`) returns a full `SubagentInfo`, which is a
 * superset — it additionally carries `prompt`, `model`, `isolation` and
 * `workspace`, none of which any reader wants. Whichever route wrote last
 * wins, and both are snapshots of the same server row, so there is nothing to
 * reconcile.
 */
export type SubagentFacts = Omit<SubagentListEntry, 'id'>;

/** One key's worth of {@link WebAppState.subagents}. Every field is optional:
 * an untouched row has no entry at all, which is how "never toggled" is told
 * apart from "explicitly collapsed" (rows default closed, groups default
 * open). */
export interface SubagentEntry {
  /**
   * What the gateway says about this child. Present only on the BARE-child-id
   * key — the `group:`/`reply:`/`body:` keys are UI-only and name no child of
   * their own. Absent until something has read the child from REST.
   */
  facts?: SubagentFacts;
  expanded?: boolean;
  /** The composer's text. Kept until a send SUCCEEDS, so a refusal never
   * throws away what the user typed. */
  draft?: string;
  /** The last send refusal's user-facing text, cleared by the next success. */
  error?: string;
  /**
   * A send is in flight from this composer. In the store rather than in
   * `useState` for the same reason `draft` is: the composer is remounted by
   * things that have nothing to do with it, and a remount mid-flight used to
   * re-arm it with the text intact and no in-flight indication — a user who
   * read that as "it didn't send" and pressed Enter again sent the follow-up
   * twice.
   */
  sending?: boolean;
}

export interface WebAppState {
  conversations: ConversationSummary[];
  transcripts: Record<string, Transcript>;
  /**
   * Everything this client knows about the sub-agent children of the
   * conversation it has open: the gateway's own facts about each child
   * (`facts`) and the UI state of the things that render them — whether the
   * row/group is open, the half-typed follow-up in a composer, the last send
   * refusal.
   *
   * ONE record, not one per concern (D3, controller ruling 1). D2 shipped
   * `subagentInfo` and `subagentUi` side by side and D3's brief asked for a
   * third keyed on overlapping identity; they are merged here instead. The
   * merge is what fixes `subagentInfo` never being cleared, for free:
   * `clearChildSubscriptions` already empties this record on a conversation
   * switch, and the facts now go with the drafts they belong beside.
   *
   * Deliberately NOT merged into `conversations`: that list is the sidebar's
   * model and the gateway only ever puts `kind: 'user'` rows in it, so a child
   * landing there would show up as a top-level thread. The row reads
   * `facts.oneShot` from here to decide whether its composer can send at all
   * (design §8.3).
   *
   * Four key shapes, all namespaced so they cannot collide (a child's
   * conversation id is a uuid, so no id can start with any of the prefixes):
   * `<child id>` for the ROW's own expansion, `group:<first child id>` for a
   * parallel-group container, `reply:<child id>` for the waiting-input reply
   * composer, and `body:<child id>` for the expanded body composer. The two
   * composers can be on screen at once (a `waiting` child with its row open),
   * so they need separate drafts — and neither may share the row's key: a
   * composer writes a fresh entry object on EVERY keystroke, and the row's
   * subscriber re-renders the whole nested transcript when it sees one.
   *
   * All of it lives HERE rather than in `SubagentBlock`'s own `useState`
   * because the components are remounted out from under the user by things
   * that have nothing to do with them: `ChatView` swaps the in-flight
   * message's subtree for a finalized `MessageRow` the moment the turn ends,
   * and a collapsed parallel group unmounts its rows outright. Component
   * state is discarded by both — the row a user opened would snap shut when
   * the parent finished, a half-typed follow-up would vanish, and a refusal
   * arriving after the swap would land on an unmounted tree and never be
   * shown at all. Keying by id also makes the guarantee structural rather
   * than dependent on React key stability.
   *
   * The composers keep their OWN keys rather than folding into the child's
   * entry, which is the one place this record is not a plain
   * `Record<subagentId, …>`. That is deliberate and load-bearing: a composer
   * writes a fresh entry object on every keystroke, so a shared entry would
   * re-render the row — and therefore the whole nested transcript and every
   * `Markdown` in it — on every character. D2 measured six Markdown
   * re-renders per keystroke on a six-message child before splitting them,
   * and pinned it with "does not re-render the nested transcript on a
   * body-composer keystroke".
   *
   * Cleared on conversation switch (see `clearChildSubscriptions`) — the
   * previous conversation's open rows, drafts and facts belong to it, not to
   * the one being opened.
   */
  subagents: Record<string, SubagentEntry>;
  /**
   * The tasks panel's ordering (design §8.4): the ids of a conversation's
   * sub-agent children, in the order `GET /conversations/:id/subagents`
   * reported them. Facts about each of those children live in
   * {@link WebAppState.subagents} under the same id; this record holds only
   * the ORDER, so a status change never has to rewrite a list and a list
   * refresh never has to rewrite an open row.
   *
   * Keyed by the PARENT conversation, and cleared with everything else on a
   * conversation switch (`clearChildSubscriptions`) — a `Record` rather than
   * a bare array because that is what makes the key-mismatch case
   * ("`subagentIds[theConversationIWasReading]` is undefined") readable at
   * the consumer instead of silently rendering another conversation's
   * children.
   */
  subagentIds: Record<string, string[]>;
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
  sendMessage(conversationId: string, text: string, images?: MobileImage[]): Promise<void>;
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
   * Replays a CHILD conversation into `transcripts[childId]` and records its
   * `SubagentInfo` (sub-agents design §8.3: "the client fetches the child
   * conversation on first expansion"). A child is an ordinary conversation as
   * far as REST is concerned — `GET /conversations/:id/messages` works on it
   * unchanged; only the LIST route filters by `kind`.
   *
   * The two fetches are independent and neither can fail the other: the
   * summary exists only to learn `oneShot` (and would be a shame to lose the
   * transcript over), while a 401 on either still means this credential is
   * dead and routes to `enterUnauthorized()` like every other REST call here.
   * Never rejects — the caller is a render effect.
   *
   * Idempotent: a child whose transcript has already been replayed is a no-op,
   * so re-expanding a row (or a row being remounted) costs nothing. The
   * bookkeeping is here, not in the component, for the same reason
   * `subagents` is. The reconnect path re-reads deliberately, bypassing
   * this — see `refreshChildTranscripts`.
   */
  /** Merges a patch into one key's record — see {@link WebAppState.subagents}. */
  patchSubagent(key: string, patch: Partial<SubagentEntry>): void;
  loadSubagentTranscript(childId: string): Promise<void>;
  /**
   * Watches a child conversation over the live socket so its transcript
   * streams into an expanded row (design §7.6/§8.3). Independent of the
   * PARENT's own single subscription: children are tracked separately, so
   * opening one never disturbs the conversation the user has open, and they
   * are re-sent after a reconnect (a dropped socket loses every server-side
   * watcher). A no-op without a live socket or an open conversation to borrow
   * the agent id from.
   *
   * REFCOUNTED, because two rows can legitimately name the same child: D1's
   * fold supports a crash-reconciled child whose start landed in one persisted
   * message and whose terminal landed in the next, so both messages render a
   * row for it. Without a count the first row to collapse would cut off the
   * other row's live stream.
   */
  subscribeSubagent(childId: string): void;
  /** Releases one hold on a child's subscription; the last one out unsubscribes. */
  unsubscribeSubagent(childId: string): void;
  /**
   * Types a user turn INTO a child ("type into a child's transcript", §8.3)
   * via `POST /subagents/:id/resume`, with an optimistic user row in
   * `transcripts[childId]` that is marked `failed` if the resume is refused.
   *
   * REST, not a WS `message` frame addressed to the child. The route matters:
   * only it reaches `coordinator.sendToChild` → `ChildHandle.send`, which is
   * the sole path that resolves a child blocked on `ask_orchestrator`, and the
   * sole place the gateway enforces the one-shot refusal, the steer cap and
   * the grant rebuild. A `message` frame goes to `hub.start` instead: against
   * a child holding its turn lease it is rejected `conversation_busy`, and
   * against one that is not it opens a SECOND turn while the child's question
   * stays blocked until it times out.
   *
   * Rethrows on failure — the caller must tell the user, since the text they
   * typed did not reach the agent. `MobileApiError.detail` carries the
   * gateway's own reason.
   *
   * Takes no `answering` hint any more. Whether the child is parked on an
   * `ask_orchestrator` question decides whether an `accepted` frame is ever
   * coming, and the client used to guess it in order to withdraw its FIFO
   * entry. It no longer needs to: pairing is keyed on a `requestId` the
   * gateway echoes, so a message that never becomes a turn simply never
   * matches anything — and a guess that was WRONG in either direction used to
   * duplicate or strand a row. See the implementation's docblock.
   */
  sendToSubagent(childId: string, text: string): Promise<void>;
  /**
   * Re-reads `GET /conversations/:id/subagents` into `subagentIds` and the
   * `facts` half of `subagents` — the tasks panel's whole model (§8.4).
   *
   * REST rather than the transcript fold, deliberately. The fold
   * (`ui/blocks/subagents.ts`) is the right model for a ROW anchored in a
   * message, and it is wrong for the panel in three ways that all point the
   * same direction: it can only see children whose events are in a message
   * this client has loaded; a BACKGROUND child is exempt from its
   * end-of-stream terminalization precisely so it does not read as dead, so
   * it stays `running` in the fold forever once its spawning turn ends and
   * nothing about its real finish ever reaches the parent's event stream;
   * and after a gateway restart the transcript is all this client has while
   * the child ROWS are what the gateway recovered from. The gateway serves
   * this route from those rows.
   *
   * Never rejects and never fails a conversation: a missing list costs the
   * panel, not the chat. A 401 still routes to `enterUnauthorized()`.
   */
  refreshSubagents(conversationId: string): Promise<void>;
  /**
   * Cancels a child and every descendant, through `POST /subagents/:id/stop`
   * — the same REST surface `sendToSubagent` uses, and for the same reason:
   * it is the only path that reaches the coordinator's cascade, and a WS
   * frame addressed at a child reaches none of it.
   *
   * The response's terminal status is applied at once so the row stops
   * offering a stop, and the list is re-read afterwards for everything the
   * response does not carry (`endedAt`, and any descendant the cascade also
   * killed).
   *
   * A 409 — the child finished on its own between the render and the click —
   * RESOLVES rather than throwing: the user's intent is satisfied, and the
   * re-read that follows is what corrects the row. Everything else rethrows,
   * so the panel can say what went wrong.
   */
  stopSubagent(childId: string): Promise<void>;
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

/**
 * The gateway's answer to a stop against a child that already finished
 * (`apps/gateway/src/subagent-management.ts`: "a `stop` against one is a 409
 * rather than a silent success, so a client that raced the child's own finish
 * learns which of the two won"). The user asked for the child to be over and
 * it is over, so this is not a failure to report — only a signal that this
 * client's picture was stale, which the re-read that follows corrects.
 */
function isAlreadyTerminal(err: unknown): boolean {
  return err instanceof MobileApiError && err.status === 409;
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

type AcceptedFrame = Extract<MobileWsServerFrame, { type: 'accepted' }>;

/**
 * A row THIS client created for a REST resume and the server has never seen.
 *
 * `sendToSubagent` gives the optimistic row the same client uuid for both
 * `id` and `turnId`, and sends that uuid as the request's `requestId`. A
 * persisted user row can never look like this: the gateway mints
 * `userMessageId` independently of the turn id
 * (`apps/gateway/src/conversation-service-sqlite.ts`), so its two ids always
 * differ. The `turnId === id` clause is therefore free defence-in-depth — the
 * `accepted` reaches every sink subscribed to the child, so without it a peer
 * could echo a `requestId` naming a SERVER row already in the transcript and
 * have every other watcher relabel it.
 */
function isLocalResumeRow(m: ConversationMessage, requestId: string): boolean {
  return m.role === 'user' && m.id === requestId && m.turnId === m.id;
}

/**
 * Fix round 4, ruling 2. `reconcileAccepted`'s first branch matches the
 * server's own user row (`m.turnId === frame.id`) and returns, so once a REST
 * read has merged that row the `requestId` branch below is UNREACHABLE and
 * the local row is orphaned even though the echo arrived and was correct —
 * a permanent duplicate of the user's own sentence.
 *
 * Adopting the local row first is not the fix: it would take the id the
 * server row already holds, and two rows would share it. The local row is
 * redundant the moment the server's row is present, so it is dropped here,
 * before any branch runs, and the server row stands.
 */
function dropPreemptedLocalRow(t: Transcript, frame: AcceptedFrame): Transcript {
  const requestId = frame.requestId;
  if (requestId === undefined) return t;
  const local = t.messages.findIndex((m) => isLocalResumeRow(m, requestId));
  if (local === -1) return t;
  // A DIFFERENT row: were the server's `userMessageId` ever the same uuid the
  // client chose (a collision, nothing more), the row proving the server's
  // copy exists would be the local row itself, and dropping it would delete
  // the only copy of the user's sentence. Left to the `requestId` branch,
  // which adopts it correctly.
  const server = t.messages.findIndex((m) => m.id === frame.userMessageId);
  if (server === -1 || server === local) return t;
  return { ...t, messages: t.messages.filter((_, index) => index !== local) };
}

/**
 * Reconciles the user side of an `accepted` frame (sub-agents design 7.6).
 *
 * Two cases, and before task C7 only the first existed:
 *
 * 1. **A turn this client started.** The client-chosen turn id (sent as `id`
 *    on the ChatSend frame) is what the optimistic user message was tagged
 *    with as `turnId` (see `sendMessage`); it becomes the server-assigned
 *    `userMessageId` now that the turn is accepted.
 * 2. **A turn the GATEWAY started** — `origin: 'notification'` (a background
 *    sub-agent finished and woke this conversation) or `origin: 'parent'`
 *    (inside a child transcript). USUALLY there is no optimistic row, so one
 *    is materialised here; without it `applyServerFrame` would open a pending
 *    assistant slot whose reply lands in the transcript with nothing above
 *    it. The row renders as a compact system row, not a user bubble
 *    (design 8.5) — its text only arrives with the next REST replay, since
 *    `accepted` carries ids, not content.
 *
 *    One `origin: 'parent'` case DOES have an optimistic row: a follow-up the
 *    user typed into a child (`sendToSubagent`). That goes out over REST and
 *    the SERVER picks the turn id, so neither id match below can hit — before
 *    fix round 2 it materialised a second row and the user saw their sentence
 *    twice. The row is now found by `frame.requestId`, the correlation id the
 *    client sent with the resume and the gateway echoes back; the optimistic
 *    row's own id IS that value, so the lookup is a plain id match.
 *
 *    An `origin: 'parent'` frame with NO `requestId` is deliberately NOT
 *    paired with anything. Two very different things produce one — the
 *    orchestrator's own `send_message` (no client row exists) and a gateway
 *    too old to echo — and they are byte-identical on the wire, so any guess
 *    is wrong half the time. Guessing by POSITION is what fix round 3
 *    removed: one missed `accepted` and every later follow-up adopted the
 *    wrong row. Materialising instead costs, on the old gateway only, one
 *    honest duplicate of the user's own sentence.
 *
 * An `accepted` with NO `origin` stays in case 1 even when its turn is
 * unknown: on the live wire the gateway omits `origin` exactly when the turn
 * is an ordinary user turn, so absent means `'user'` there, and inventing a
 * user row for one would put an empty bubble in the transcript.
 */
function reconcileAccepted(
  base: Transcript,
  frame: AcceptedFrame,
  conversationId: string,
): Transcript {
  const origin = frame.origin;
  // Ruling 2: runs BEFORE every branch below, because the first of them
  // short-circuits on the very row that makes the local one redundant.
  const t = dropPreemptedLocalRow(base, frame);
  const optimistic = t.messages.findIndex((m) => m.role === 'user' && m.turnId === frame.id);
  if (optimistic !== -1) {
    const messages = [...t.messages];
    messages[optimistic] = {
      ...messages[optimistic],
      id: frame.userMessageId,
      status: 'completed',
      ...(origin ? { origin } : {}),
    };
    return { ...t, messages };
  }

  // The REST-resume row. Both of its ids are client uuids the server has never
  // seen; `requestId` is the one the client chose and the gateway echoed, so
  // it names the row exactly. No status filter on purpose: a row already
  // marked `failed` by a REST call that timed out on a request the gateway
  // nonetheless acted on is repaired here rather than duplicated.
  if (frame.requestId !== undefined) {
    const requestId = frame.requestId;
    const pending = t.messages.findIndex((m) => isLocalResumeRow(m, requestId));
    if (pending !== -1) {
      const messages = [...t.messages];
      messages[pending] = {
        ...messages[pending],
        id: frame.userMessageId,
        turnId: frame.id,
        status: 'completed',
        ...(origin ? { origin } : {}),
      };
      return { ...t, messages };
    }
  }

  const known = t.messages.findIndex((m) => m.id === frame.userMessageId);
  if (known !== -1) {
    if (!origin) return t;
    const messages = [...t.messages];
    messages[known] = { ...messages[known], origin };
    return { ...t, messages };
  }

  if (!origin || origin === 'user') return t;

  const now = new Date().toISOString();
  const materialised: ConversationMessage = {
    id: frame.userMessageId,
    conversationId,
    turnId: frame.id,
    ordinal: t.messages.length + 1,
    role: 'user',
    status: 'completed',
    content: { type: 'user', text: '' },
    createdAt: now,
    updatedAt: now,
    origin,
  };
  return { ...t, messages: [...t.messages, materialised] };
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
  /**
   * The conversation this socket is subscribed to (sub-agents design 7.6),
   * and the agent id the `unsubscribe` frame needs. Exactly one at a time:
   * the store watches the conversation the user has open, and drops it on the
   * way out so a long session can't accumulate subscriptions. `message` and
   * `resume` auto-subscribe server-side, but this store subscribes
   * EXPLICITLY, so a conversation that is merely open — never typed into —
   * still receives the server-initiated turns that carry a background
   * sub-agent's completion notification.
   */
  let subscribedConversationId: string | null = null;
  let subscribedAgentId: string | null = null;
  /**
   * Correlation ids of the `subscribe`/`unsubscribe` frames this store sent.
   * An OLDER gateway does not know those frame types: `parseChatClientFrame`
   * returns null and it answers with `{ type: 'error', id: <that id>,
   * conversationId, code: 'validation_failed' }`. Routed normally that would
   * mark the conversation `'interrupted'` and raise a red banner on EVERY
   * open — a new client would look broken against an old gateway, which is
   * exactly the backward compatibility this feature promises. Ignored here
   * instead, by id, so a genuine error frame for a real turn is untouched.
   */
  const subscriptionFrameIds = new Set<string>();
  /**
   * Child conversations an expanded row wants watched (§8.3), and the ones a
   * `subscribe` frame has actually gone out for on the CURRENT socket. Two
   * collections rather than one because they diverge across a reconnect: the
   * intent survives, the server-side watcher does not.
   *
   * Deliberately separate from `subscribedConversationId`/`subscribedAgentId`,
   * which are a single slot for the conversation the user has open. Reusing
   * that slot for a child would make the next `openConversation` unsubscribe
   * the child and silently leave the parent watched.
   */
  const desiredChildSubscriptions = new Map<string, number>();
  const activeChildSubscriptions = new Map<string, string>();
  /**
   * Children whose transcript has been replayed on this store. Deliberately
   * outside the components: a remounted row must not pay for the same history
   * twice (see `subagents`), and the reconnect path needs one place to
   * invalidate.
   */
  const loadedChildTranscripts = new Set<string>();
  /**
   * Every child this store has ever put a transcript under, whether it is
   * still watched or not. `desiredChildSubscriptions`/`loadedChildTranscripts`
   * both shrink when a row is collapsed, so neither can be used to find a
   * collapsed child's leftover transcript at conversation-switch time — but
   * that transcript is exactly the one nothing else would ever clear.
   */
  const childTranscriptIds = new Set<string>();
  /**
   * Monotonic sequence for `refreshSubagents` reads, so only the NEWEST one
   * ever writes. Every trigger fires in bursts — three children starting
   * inside one turn is three reads — and nothing makes REST answer them in
   * order, so a read issued before a child finished can resolve after one
   * issued after it. Last-write-wins would park the panel on the older
   * snapshot with nothing left to correct it.
   */
  let subagentReadSeq = 0;
  let appliedSubagentReadSeq = 0;
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

  /**
   * Watch `conversationId` on `target` so the gateway fans server-initiated
   * turns out to it. Best-effort: a send failure here must never take down an
   * otherwise healthy connection — an older gateway that has never heard of
   * `subscribe` simply answers with a `validation_failed` error frame, and
   * ordinary chat keeps working without it.
   */
  function sendSubscribe(target: ChatSocket, agentId: string, conversationId: string): void {
    const frame: MobileWsClientFrame = {
      type: 'subscribe',
      id: crypto.randomUUID(),
      agentId,
      conversationId,
    };
    subscriptionFrameIds.add(frame.id);
    try {
      target.send(frame);
      subscribedConversationId = conversationId;
      subscribedAgentId = agentId;
    } catch (err) {
      console.error('WebAppStore: failed to send subscribe frame', err);
    }
  }

  /** Drops the live subscription, if any, over the socket that holds it. */
  function sendUnsubscribe(): void {
    const conversationId = subscribedConversationId;
    const agentId = subscribedAgentId;
    subscribedConversationId = null;
    subscribedAgentId = null;
    if (!socket || !conversationId || !agentId) return;
    const frame: MobileWsClientFrame = {
      type: 'unsubscribe',
      id: crypto.randomUUID(),
      agentId,
      conversationId,
    };
    subscriptionFrameIds.add(frame.id);
    try {
      socket.send(frame);
    } catch (err) {
      console.error('WebAppStore: failed to send unsubscribe frame', err);
    }
  }

  /** Forgets every child subscription. Called where the socket itself goes
   * away: the gateway drops a closed sink's watchers on its own, so there is
   * nothing to send — only local bookkeeping to reset. */
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

    /**
     * Re-reads the newest page of messages for `conversationId` and merges it
     * into the transcript. Used for a turn the GATEWAY started (sub-agents
     * design 7.3): its `accepted` carries ids but no text, so the user row
     * this store materialised is empty and the §8.5 notification row would
     * read the generic fallback for the rest of the session — two background
     * children finishing would produce two identical, unattributable lines.
     * The REST row carries the notification block, whose `<summary>` is what
     * the row is specified to show. Best-effort and silent, except a 401,
     * which routes like every other REST call here.
     */
    function refreshMessages(conversationId: string): void {
      // A CHILD transcript, not the open conversation's own — `done` fires
      // this for a child every time the orchestrator drives one
      // (`origin: 'parent'`). Two things follow, and D3 fixed both: this was
      // the one writer of a child transcript that never REGISTERED what it
      // wrote, and `childTranscriptIds` is the only record a conversation
      // switch has of which `transcripts` entries belong to children.
      // `currentConversationId !== null` matters: after `dispose()` or an
      // auth failure it is nulled, and without this a late frame for the
      // PARENT would be classified as a child, registered, and then have its
      // transcript deleted by the next conversation switch.
      const child = currentConversationId !== null && conversationId !== currentConversationId;
      if (child) childTranscriptIds.add(conversationId);
      rest
        .getMessages(conversationId)
        .then((page) => {
          // The switch happened while this read was in flight:
          // `clearChildSubscriptions` deleted this entry and emptied the
          // registry, so writing now would put back a transcript with no
          // reader (the row that owned it is gone with its conversation) and
          // no owner — invisible to every future clear, and therefore
          // permanent. Registering above is not enough on its own; a late
          // write has to be dropped as well.
          if (child && !childTranscriptIds.has(conversationId)) return;
          updateTranscript(conversationId, (t) => ({
            ...t,
            messages: mergeMessagesById(t.messages, page.items),
          }));
        })
        .catch((err: unknown) => {
          if (isAuthError(err)) enterUnauthorized();
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

    /**
     * Subscribes `target` to the conversation the user just opened
     * (sub-agents design 7.6, ruling 1).
     *
     * Every failure here is swallowed, INCLUDING a 401 — unlike everywhere
     * else in this store, which routes one to `enterUnauthorized()`. Two
     * reasons: a missing subscription costs server-initiated turns, never the
     * conversation itself, so it must not be able to fail an otherwise
     * healthy open; and `openConversation`'s own history replay is a REST
     * call that already succeeded moments earlier on this same credential, so
     * a credential that dies in the gap is detected by the very next call
     * (the reconnect path's `resolveAgentId`, `maybeRefreshAutoTitle`, …)
     * rather than being lost.
     */
    async function subscribeToOpenConversation(
      target: ChatSocket,
      conversationId: string,
    ): Promise<void> {
      let agentId: string | null = null;
      try {
        agentId = await resolveAgentId(conversationId);
      } catch {
        return;
      }
      if (!agentId || disposed || socket !== target) return;
      sendSubscribe(target, agentId, conversationId);
    }

    /**
     * Sends `subscribe` for every wanted child that has none on this socket.
     * Children ride the PARENT's agent id: a child conversation belongs to the
     * same agent, and the hub keys its watcher registry on that pair.
     *
     * Best-effort throughout, exactly like the parent's own subscription: an
     * older gateway answers `validation_failed` (swallowed by id) and a missing
     * agent id just means no live stream until the next attempt.
     */
    async function flushChildSubscriptions(target: ChatSocket, parentId: string): Promise<void> {
      if (desiredChildSubscriptions.size === 0) return;
      let agentId: string | null = null;
      try {
        agentId = await resolveAgentId(parentId);
      } catch {
        return;
      }
      if (!agentId || disposed || socket !== target || currentConversationId !== parentId) return;
      for (const childId of desiredChildSubscriptions.keys()) {
        if (activeChildSubscriptions.has(childId)) continue;
        const frame: MobileWsClientFrame = {
          type: 'subscribe',
          id: crypto.randomUUID(),
          agentId,
          conversationId: childId,
        };
        subscriptionFrameIds.add(frame.id);
        try {
          target.send(frame);
          activeChildSubscriptions.set(childId, agentId);
        } catch (err) {
          console.error('WebAppStore: failed to send child subscribe frame', err);
        }
      }
    }

    /**
     * The actual child replay: newest page of the child's messages, plus its
     * conversation summary for `SubagentInfo` (that is where `oneShot` lives).
     * Independent halves — a failed summary must not cost the transcript — but
     * a 401 from either still means this credential is dead.
     */
    async function fetchChildTranscript(childId: string): Promise<void> {
      // Read BEFORE the fetch: the summary below is a snapshot taken at the
      // same moment, and only a stream that was already stale then may be
      // cleared against it. See the clear in the merge.
      const pendingBefore = get().transcripts[childId]?.pending?.turnId;
      const [messages, childSummary] = await Promise.allSettled([
        rest.getMessages(childId),
        rest.getConversation(childId),
      ]);

      const summary = childSummary.status === 'fulfilled' ? childSummary.value : undefined;

      if (messages.status === 'fulfilled') {
        const items = messages.value.items;
        // Re-registered AFTER the await: a conversation switch during the
        // fetch cleared the set, and this write is about to recreate the
        // entry it removed.
        childTranscriptIds.add(childId);
        updateTranscript(childId, (t) => {
          const merged: Transcript = { ...t, messages: mergeMessagesById(t.messages, items) };
          // Fix round 4, ruling 1. A `done` missed while nobody was watching
          // (the collapse window ruling 2 exists to cover, or a reconnect gap)
          // leaves `streaming`/`pending` holding a half-finished copy of the
          // very reply this read just landed, which `ChildTranscript` renders
          // as a live bubble under the finished one — forever, since
          // `transcripts` outlives the row.
          //
          // Cleared ONLY when the server says that specific turn is over:
          // `activeTurnId === pending.turnId` is a client that reconnected
          // mid-turn and whose partial is the real thing. The bare
          // `activeTurnId === null` test is not enough — the turn can finish
          // DURING this fetch, and then the already-broadcast `done` arrives
          // with no `pending` and blanks the row it matches (guarded from the
          // other side in `assemble.ts`'s `keepExistingContent`).
          //
          // In the same `updateTranscript` as the merge on purpose: the user
          // goes from stale-partial to finished-row in one commit, never to a
          // transcript with neither.
          //
          // `pendingBefore` closes the third case, which is the one this clear
          // could itself have caused: the summary predates the write, so a
          // turn that STARTS during the fetch would be judged against a
          // snapshot that never saw it, and its live stream wiped.
          const pendingTurnId = t.pending?.turnId;
          // The messages page has to AGREE that the turn is over. The two
          // reads are independent requests, so `finishTurn` can land between
          // them: a page built before it still carries the assistant row at
          // `status: 'streaming'` while the summary already says `null`.
          // Clearing on that pair would cost the `done` its `pending` — and
          // with it the `origin: 'parent'` that is the only trigger for the
          // post-`done` re-read (`handleFrame`'s `finishingOrigin`) — leaving
          // the row stuck on the partial snapshot with nothing to fetch the
          // rest of it.
          const serverStillStreaming = merged.messages.some(
            (m) => m.role === 'assistant' && m.turnId === pendingTurnId && m.status === 'streaming',
          );
          if (
            summary &&
            pendingTurnId !== undefined &&
            pendingTurnId === pendingBefore &&
            summary.activeTurnId !== pendingTurnId &&
            !serverStillStreaming
          ) {
            const { pending: _cleared, ...rest } = merged;
            return { ...rest, streaming: null };
          }
          return merged;
        });
      }
      const info = summary?.subagent;
      if (info) {
        // MERGED into the child's existing entry, never assigned over it:
        // the same key carries `expanded` and, mid-send, `sending`, and a
        // replacement would collapse an open row or disarm a live composer.
        set((state) => ({
          subagents: {
            ...state.subagents,
            [childId]: { ...state.subagents[childId], facts: info },
          },
        }));
      }
      if (messages.status === 'rejected') {
        // Not loaded after all — let the next expansion try again.
        loadedChildTranscripts.delete(childId);
        if (isAuthError(messages.reason)) {
          enterUnauthorized();
          return;
        }
      }
      if (childSummary.status === 'rejected' && isAuthError(childSummary.reason)) {
        enterUnauthorized();
      }
    }

    /**
     * Re-walk every watched child's history after a reconnect.
     *
     * Re-subscribing alone is not enough and the gap is invisible: the PARENT
     * resumes from `sinceSeq: lastSeq`, but a child has no such cursor on this
     * client, so everything it emitted while the socket was down is simply
     * missing from `transcripts[childId]` — permanently, since the row's
     * replay is otherwise once per store.
     */
    function refreshChildTranscripts(): void {
      for (const childId of desiredChildSubscriptions.keys()) {
        if (!loadedChildTranscripts.has(childId)) continue;
        void fetchChildTranscript(childId);
      }
    }

    /**
     * The list read behind `refreshSubagents`. Kept beside
     * `refreshChildTranscripts` because it is the same kind of thing: a
     * recovery read the panel cannot get from the socket, since the gateway
     * replays nothing on a re-`subscribe`.
     */
    async function fetchSubagentList(conversationId: string): Promise<void> {
      const readSeq = ++subagentReadSeq;
      let entries: SubagentListEntry[];
      try {
        entries = (await rest.listSubagents(conversationId)).subagents;
      } catch (err) {
        if (isAuthError(err)) enterUnauthorized();
        // Otherwise silent: the panel simply keeps the snapshot it had. Every
        // trigger fires again on the next start, finish, reconnect or open.
        return;
      }
      // Landed after the user navigated away: `clearChildSubscriptions` has
      // emptied both records, and writing now would put a dead
      // conversation's children back where only the NEXT switch could find
      // them again.
      if (currentConversationId !== conversationId) return;
      // Answered out of order behind a newer read — see `subagentReadSeq`.
      if (readSeq <= appliedSubagentReadSeq) return;
      appliedSubagentReadSeq = readSeq;
      set((state) => {
        const subagents = { ...state.subagents };
        for (const entry of entries) {
          const { id, ...facts } = entry;
          // MERGED, never assigned over: the same key carries the row's
          // `expanded` and, mid-send, its composer's `sending`.
          subagents[id] = { ...subagents[id], facts };
        }
        return {
          subagents,
          subagentIds: { ...state.subagentIds, [conversationId]: entries.map((e) => e.id) },
        };
      });
    }

    /**
     * Re-read the OPEN conversation's children. Every trigger in this store
     * is about the conversation the user is looking at — that is the only
     * one the panel can show, and `fetchSubagentList` would drop a read for
     * any other on arrival anyway.
     */
    function refreshCurrentSubagents(): Promise<void> {
      const conversationId = currentConversationId;
      if (!conversationId) return Promise.resolve();
      return fetchSubagentList(conversationId);
    }

    /**
     * Everything that belongs to the conversation being left: the child
     * subscriptions (intent AND server-side), the replay cache, the
     * unreconciled follow-ups, and the rows' own UI state. Inside the store
     * callback rather than beside the other subscription helpers because
     * `subagents` is real state and needs `set`.
     *
     * Clearing `subagents` is what keeps re-opening a conversation from
     * auto-expanding every row the user ever looked at — each of which would
     * fire two REST calls and a `subscribe` on open. Rows collapsed on reopen
     * is the intended behaviour.
     *
     * The CHILD transcripts go with them (fix round 4, ruling 4). `transcripts`
     * was otherwise never reset, so anything wrong in a child's copy — a
     * duplicated row, an orphaned local row, a stale streaming ghost — was
     * permanent for the life of the store instead of clearing on a navigation.
     * Nothing depends on them surviving: every reader is a `SubagentBlock` row,
     * which is collapsed on reopen (`subagents` cleared just below) and
     * re-reads from REST when expanded (`loadedChildTranscripts` cleared just
     * above). The PARENT conversation's transcript is not touched.
     */
    function clearChildSubscriptions(): void {
      desiredChildSubscriptions.clear();
      activeChildSubscriptions.clear();
      loadedChildTranscripts.clear();
      const children = [...childTranscriptIds];
      childTranscriptIds.clear();
      // A read still in flight belongs to the conversation being left; bump
      // the applied cursor so nothing of its can land in the new one even if
      // the `currentConversationId` check above it were ever relaxed.
      appliedSubagentReadSeq = subagentReadSeq;
      set((state) => {
        if (children.length === 0) return { subagents: {}, subagentIds: {} };
        const transcripts = { ...state.transcripts };
        for (const childId of children) delete transcripts[childId];
        return { subagents: {}, subagentIds: {}, transcripts };
      });
    }

    function handleFrame(frame: MobileWsServerFrame): void {
      // An older gateway rejecting our `subscribe`/`unsubscribe` (see
      // `subscriptionFrameIds`). Never a transcript or conversation event.
      if (frame.type === 'error' && subscriptionFrameIds.delete(frame.id)) return;
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

      // Read BEFORE `applyServerFrame` consumes `pending` on `done`: this is
      // the only place the finishing turn's origin is still known.
      const finishingOrigin =
        frame.type === 'done' ? get().transcripts[conversationId]?.pending?.origin : undefined;

      updateTranscript(conversationId, (t) => {
        const reconciled: Transcript =
          frame.type === 'accepted' ? reconcileAccepted(t, frame, conversationId) : t;
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
        // A turn the gateway started: pull the row's real text (see
        // `refreshMessages`). An ordinary user turn already has its text
        // locally and never pays for this.
        if (finishingOrigin && finishingOrigin !== 'user') {
          refreshMessages(conversationId);
        }
        // The trigger a BACKGROUND child needs, and the one the two below
        // cannot give it. A background child is spawned to OUTLIVE the turn
        // that spawned it, so its finish never lands as a
        // `subagent_finished` in that turn's message — it arrives as a
        // notification turn on the parent (§7.3/§8.5). Without this the
        // panel would show it `running` until the user navigated away and
        // back, which is the panel's headline case. One read per parent
        // turn, and it backstops every other trigger going missing.
        if (conversationId === currentConversationId) {
          void fetchSubagentList(conversationId);
        }
      }

      // The tasks panel's live half (§8.4), alongside the per-turn read
      // above. The panel's model is REST, and these two events are what make
      // a FOREGROUND child's row move before its turn ends: a start adds a
      // row, a finish stops one spinning. `subagent_progress` deliberately
      // does not qualify — it is transient and never persisted, so
      // refreshing on it would be a round trip per tool call for a row whose
      // only live field (elapsed) ticks locally anyway.
      //
      // Both reads see a row that already agrees with the event they came
      // from: `ChildHandle.start` writes the child row (`createChild`)
      // BEFORE `emitStarted`, and `finalizeTerminal` persists the terminal
      // row before emitting `subagent_finished`. Neither can race ahead of
      // its own write.
      //
      // Matched by STRING rather than through `ui/blocks/subagents.ts`'s
      // `isSubagentEvent`: that predicate also covers the legacy `worker_*`
      // mirrors, which the gateway emits for the very same children, so
      // sharing it would double every read until D8 removes them — and the
      // store has no business importing from `ui/`.
      if (
        frame.type === 'event' &&
        conversationId === currentConversationId &&
        (frame.event.type === 'subagent_started' || frame.event.type === 'subagent_finished')
      ) {
        void fetchSubagentList(conversationId);
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
      // Ids only matter for the socket they were sent on: the new gateway
      // never acks a `subscribe`, so without this the set would grow by one
      // uuid per connect for the life of the store.
      subscriptionFrameIds.clear();
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
      // Drop the conversation subscription over the socket that still holds
      // it, before the close below takes that socket away.
      sendUnsubscribe();
      clearChildSubscriptions();
      subscriptionFrameIds.clear();
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
        // `resume` auto-subscribes server-side, but say it explicitly: the
        // resume frame can be rejected (an unknown/finished turn id) before
        // the hub ever registers this socket as a watcher, and the whole
        // point of the subscription is that it outlives any one turn.
        sendSubscribe(attempted, agentId, conversationId);
        // Every watcher died with the old socket, including the children an
        // expanded row is still showing — without this an open sub-agent row
        // goes permanently silent after one reconnect.
        activeChildSubscriptions.clear();
        void flushChildSubscriptions(attempted, conversationId);
        refreshChildTranscripts();
        // Same gap, one level up: children that started or finished while the
        // socket was down left no trace on this client, and the panel is the
        // one surface whose whole job is to say which are still going.
        void fetchSubagentList(conversationId);
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
      subagents: {},
      subagentIds: {},
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
          // Leaving this conversation: drop its subscription first, so a long
          // session that visits many conversations never accumulates them
          // server-side (sub-agents design 7.6).
          sendUnsubscribe();
          socket.close();
          socket = null;
        }
        // Nothing outstanding can be answered over a socket that is gone, and
        // the previous conversation's expanded children belong to it, not to
        // the one being opened.
        clearChildSubscriptions();
        subscriptionFrameIds.clear();
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
        // Deliberately NOT awaited: on a deep link (conversation list not
        // loaded yet) `resolveAgentId` does a REST round trip, and blocking
        // the connected transition on it would keep the composer disabled —
        // and `sendMessage` throwing — for a request that has nothing to do
        // with the socket. The subscription only governs turns nobody has
        // started yet; it can land a moment later.
        void subscribeToOpenConversation(attached, conversationId);
        // The tasks panel's first read (§8.4), on the same terms as the
        // subscription above: not awaited, and never able to fail the open.
        void fetchSubagentList(conversationId);
      },

      async sendMessage(conversationId: string, text: string, images?: MobileImage[]) {
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
          // Phase 4 Task 5: images ride on the optimistic message too, so
          // the transcript shows the thumbnails before the gateway echoes
          // them back. Omitted (not `undefined`) when there are none, to
          // keep the shape byte-identical to a text-only send.
          content:
            images && images.length > 0 ? { type: 'user', text, images } : { type: 'user', text },
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
          ...(images && images.length > 0 ? { images } : {}),
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
        // A `role: 'user'` row whose origin is NOT the user is a system
        // notification the gateway wrote (sub-agents design 7.3/8.5) — its
        // text is the `[SYSTEM NOTIFICATION - NOT USER INPUT]` block the
        // orchestrator was fed. Resending it would submit that block as if
        // the user had typed it. `ChatView` hides the affordance too; this
        // guard holds regardless of caller.
        if (transcript.messages[index].origin && transcript.messages[index].origin !== 'user') {
          return false;
        }
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

      patchSubagent(key, patch) {
        set((state) => ({
          subagents: { ...state.subagents, [key]: { ...state.subagents[key], ...patch } },
        }));
      },

      async loadSubagentTranscript(childId) {
        childTranscriptIds.add(childId);
        if (loadedChildTranscripts.has(childId)) return;
        loadedChildTranscripts.add(childId);
        await fetchChildTranscript(childId);
      },

      subscribeSubagent(childId) {
        childTranscriptIds.add(childId);
        const holds = desiredChildSubscriptions.get(childId) ?? 0;
        desiredChildSubscriptions.set(childId, holds + 1);
        if (holds > 0) return;
        // OPTIMISATION, not a correctness guard: the watcher outlived the
        // release (see `unsubscribeSubagent`), so the socket already carries
        // this child and there is no `resolveAgentId` round trip to pay for.
        // Removing this line changes no outcome — `flushChildSubscriptions`
        // skips any child already in `activeChildSubscriptions` on its own.
        if (activeChildSubscriptions.has(childId)) return;
        const parentId = currentConversationId;
        if (!socket || !parentId) return;
        void flushChildSubscriptions(socket, parentId);
      },

      /**
       * Release one hold. The BOOKKEEPING is immediate; the wire frame is not.
       *
       * A row is remounted by things that have nothing to do with it — most
       * often `ChatView` swapping the streaming subtree for the finalized
       * `MessageRow` when the parent turn ends, which `applyServerFrame`'s
       * `done` case does in a single `set()` and therefore a single React
       * commit. React runs the removed subtree's passive cleanup before the
       * added subtree's passive setup in that one commit, so the refcount
       * genuinely goes 1 -> 0 -> 1 and a synchronous release put a real
       * `unsubscribe` on the wire. The gateway replays nothing on the
       * following `subscribe` (`chat-ws.ts`: "Bookkeeping only: no
       * acknowledgement frame"), so anything the child emitted in that gap
       * was lost permanently — including a `done`, which is unrecoverable
       * because `refreshMessages` is keyed off it.
       *
       * Deferring to a microtask closes it: both effects of the same commit
       * have run by the time it fires, so a remount re-checks as `holds > 0`
       * and never touches the socket. A genuine collapse still releases, one
       * microtask later. The refcount is what makes the re-`subscribe` a
       * no-op; `activeChildSubscriptions` being cleared only inside the
       * microtask is what lets `subscribeSubagent` SKIP the `resolveAgentId`
       * round trip on the way (see the note there — it is an optimisation,
       * not the correctness guard).
       */
      unsubscribeSubagent(childId) {
        const holds = desiredChildSubscriptions.get(childId) ?? 0;
        if (holds > 1) {
          desiredChildSubscriptions.set(childId, holds - 1);
          return;
        }
        desiredChildSubscriptions.delete(childId);
        queueMicrotask(() => {
          // Re-taken by a remount, or already released by an earlier
          // microtask — either way this one has nothing to do.
          if ((desiredChildSubscriptions.get(childId) ?? 0) > 0) return;
          // A genuine release makes the cached transcript stale: nothing
          // replays what the child emits while nobody is watching (the
          // gateway acknowledges a `subscribe` with no catch-up at all), so
          // the next expansion has to re-read from REST or the child's whole
          // reply to a queued steer is simply never fetched. Done HERE rather
          // than beside the frame send below, so it also covers a child that
          // was expanded while the socket was down and therefore never got an
          // `activeChildSubscriptions` entry to release.
          loadedChildTranscripts.delete(childId);
          const agentId = activeChildSubscriptions.get(childId);
          if (!agentId) return;
          activeChildSubscriptions.delete(childId);
          // Re-read at FIRE time, not at call time: `clearChildSubscriptions`
          // (a conversation switch, dispose, unauthorized) may have run in
          // between, and a frame for a conversation the user has left must
          // not go out.
          if (!socket) return;
          const frame: MobileWsClientFrame = {
            type: 'unsubscribe',
            id: crypto.randomUUID(),
            agentId,
            conversationId: childId,
          };
          subscriptionFrameIds.add(frame.id);
          try {
            socket.send(frame);
          } catch (err) {
            console.error('WebAppStore: failed to send child unsubscribe frame', err);
          }
        });
      },

      /**
       * A follow-up typed into a child, over `POST /subagents/:id/resume`.
       *
       * The optimistic row's own id is sent as the request's `requestId`, and
       * the gateway echoes it on the `accepted` frame of whichever turn the
       * message becomes. That echo is the ONLY correlation there is: the
       * server picks the turn id for a resume, so nothing else in the frame
       * names this row. Fix round 3 replaced a positional FIFO with it —
       * three server paths reach this method and only one of them is
       * guaranteed to produce an `accepted` at all, so pairing by position
       * broke permanently the first time one went missing:
       *
       * 1. `mode: 'resumed'` — the child was finished, so a NEW turn starts on
       *    its conversation and an `accepted` follows almost at once. The
       *    gateway starts that turn INSIDE `sendToChild`, before the route
       *    responds, so the frame can beat this promise — which is why the row
       *    exists before the await and the id travels in the request itself.
       * 2. `mode: 'queued'`, steered — a live child, so the message goes on
       *    `ChildHandle`'s steer queue and becomes a turn only when the
       *    current one ends. An `accepted` DOES arrive, just minutes later,
       *    and it carries the same id however many turns intervene.
       * 3. `mode: 'queued'`, answered — the child was parked on
       *    `ask_orchestrator`, so `ChildHandle.send` resolves the waiter and
       *    the text becomes that tool's RESULT inside the running turn. No new
       *    turn and no `accepted`, ever. Nothing has to be withdrawn: an id
       *    that is never echoed simply never matches, and the local row is the
       *    only record of the answer (it does not survive a reload — no server
       *    row will ever exist for it).
       *
       * The id is sent on every path, including the one the caller believes is
       * an answer. Getting that belief wrong used to duplicate a row (withdrawn
       * early, then re-materialised) or strand one; now a misclassification in
       * either direction is self-correcting, because the echo — not the
       * client's guess — decides.
       */
      async sendToSubagent(childId, text) {
        childTranscriptIds.add(childId);
        // The optimistic row goes in FIRST so the text is visible in the
        // child's transcript while the resume is in flight, and so there is
        // something to mark `failed` if it is refused. Its id doubles as the
        // request's correlation id.
        const localId = crypto.randomUUID();
        const optimistic: ConversationMessage = {
          id: localId,
          conversationId: childId,
          turnId: localId,
          ordinal: (get().transcripts[childId]?.messages.length ?? 0) + 1,
          role: 'user',
          status: 'accepted',
          content: { type: 'user', text },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          origin: 'parent',
        };
        updateTranscript(childId, (t) => ({ ...t, messages: [...t.messages, optimistic] }));

        try {
          await rest.resumeSubagent(childId, text, localId);
        } catch (err) {
          updateTranscript(childId, (t) => ({
            ...t,
            messages: t.messages.map((m) =>
              m.id === localId ? { ...m, status: 'failed' as const } : m,
            ),
          }));
          if (isAuthError(err)) enterUnauthorized();
          // Rethrown, unlike `cancelTurn`'s swallow: the user typed this and it
          // did not reach the agent, so the row that owns the composer has to
          // say so.
          throw err;
        }

        // The send succeeded, so the row must not sit at `accepted` for the
        // life of the store waiting for a frame that may be minutes away or
        // may never come (path 3). A no-op if the `accepted` already beat us
        // here: reconciliation renamed the row to the server's id.
        updateTranscript(childId, (t) => ({
          ...t,
          messages: t.messages.map((m) =>
            m.id === localId && m.status === 'accepted'
              ? { ...m, status: 'completed' as const }
              : m,
          ),
        }));
      },

      async refreshSubagents(conversationId) {
        await fetchSubagentList(conversationId);
      },

      async stopSubagent(childId) {
        try {
          const { status } = await rest.stopSubagent(childId);
          // Applied before the re-read so the button stops offering a stop
          // on this frame rather than one round trip later. The response is
          // authoritative: the route falls back to writing `cancelled`
          // itself when the cascade reached a child this gateway process no
          // longer holds a handle for, so it is not always guessable.
          set((state) => {
            const existing = state.subagents[childId];
            if (!existing?.facts) return {};
            return {
              subagents: {
                ...state.subagents,
                [childId]: { ...existing, facts: { ...existing.facts, status } },
              },
            };
          });
        } catch (err) {
          if (isAuthError(err)) enterUnauthorized();
          // Not a raced finish — the caller has to be able to say what went
          // wrong. Still re-read on the way out: a partial cascade may have
          // killed descendants before the refusal.
          if (!isAlreadyTerminal(err)) {
            void refreshCurrentSubagents();
            throw err;
          }
        }
        await refreshCurrentSubagents();
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
