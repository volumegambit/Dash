import type {
  ConversationMessage,
  ConversationSummary,
  MobileAgent,
  MobileImage,
  MobileWsClientFrame,
  MobileWsServerFrame,
  SubagentListEntry,
  SubagentUsage,
} from '@dash/mobile-contract';
import type {
  MobileV2ConversationBootstrap,
  MobileV2ConversationMessage,
  MobileV2ConversationSummary,
  MobileV2PendingInput,
  MobileV2SequencedFrame,
  MobileV2WsClientFrame,
  MobileV2WsServerFrame,
} from '@dash/mobile-contract-v2';
import { create } from 'zustand';
import type { StoreApi, UseBoundStore } from 'zustand';
import type { ChatSocket, ChatSocketClose, FrameHandler } from '../api/chat-socket';
import { MobileApiError, type MobileRestClient } from '../api/rest';
import {
  type Transcript,
  type V2OrdinarySendIntent,
  type V2Transcript,
  applyServerFrame,
  applyV2ServerFrame,
  prependV2MessagePage,
  reconcileV2Accepted,
  transcriptFromBootstrap,
} from './assemble';
import { readClientLocation } from './location.js';

export type WebChatProtocol =
  | { version: 1; capabilities: string[] }
  | { version: 2; capabilities: string[] };

type V2CommandFrame = Exclude<MobileV2WsClientFrame, { type: 'hello' }>;

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

/**
 * Field-equality for two {@link SubagentFacts} snapshots (fix I3a).
 *
 * Compared against the INCOMING row's keys, not a fixed list: the two routes
 * that write this field disagree about shape — the child summary read by
 * `loadSubagentTranscript` returns a `SubagentInfo`, a superset carrying
 * `prompt`/`model`/`isolation`/`workspace` — and a list read whose own fields
 * all match must count as "nothing new" rather than as a downgrade worth
 * writing. Nothing reads those extra fields, so keeping the richer object is
 * the better of the two outcomes anyway.
 *
 * `usage` is the one nested value (`{ inputTokens, outputTokens }`) and is
 * re-allocated by every JSON parse, so it is compared field-wise; a reference
 * compare would report every child that has run a turn as changed and defeat
 * the whole thing.
 */
function sameFacts(previous: SubagentFacts | undefined, next: SubagentFacts): boolean {
  if (!previous) return false;
  const before = previous as Record<string, unknown>;
  for (const [key, value] of Object.entries(next as Record<string, unknown>)) {
    if (key === 'usage') {
      const a = before.usage as SubagentUsage | undefined;
      const b = value as SubagentUsage | undefined;
      if (a?.inputTokens !== b?.inputTokens || a?.outputTokens !== b?.outputTokens) return false;
      continue;
    }
    if (before[key] !== value) return false;
  }
  return true;
}

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
  /**
   * The REST client this store was built with, exposed so read-only screens
   * (the skills browser) can call the mobile API without a second client and
   * a second set of credentials.
   */
  rest: MobileRestClient;
  conversations: ConversationSummary[];
  transcripts: Record<string, Transcript>;
  v2Transcripts: Record<string, V2Transcript>;
  protocol: WebChatProtocol;
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
  enqueueInput(
    conversationId: string,
    behavior: 'steer' | 'followUp',
    text: string,
    images?: MobileImage[],
  ): Promise<MobileV2PendingInput>;
  editFollowUp(
    conversationId: string,
    inputId: string,
    expectedRevision: number,
    text: string,
    images?: MobileImage[],
  ): Promise<MobileV2PendingInput>;
  removeFollowUp(conversationId: string, inputId: string, expectedRevision: number): Promise<void>;
  resumeFollowUps(conversationId: string): Promise<void>;
  loadOlderMessages(conversationId: string): Promise<void>;
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
   * (new `revision` included) on success. That reconciliation is field-scoped:
   * it cannot replace newer lifecycle or queue state received while the PATCH
   * was in flight, and a superseded rename attempt cannot settle over the
   * user's newer title.
   *
   * A no-op if `conversationId` isn't in `conversations` (nothing to
   * optimistically rename). On REST failure, rolls the optimistic title back
   * to its prior value; a 401 additionally routes to `enterUnauthorized()`
   * (same "revoked credential" handling as every other REST call in this
   * store) and is swallowed rather than rethrown, but any other failure
   * (network error, validation) propagates to the caller so the UI can show
   * it — same "don't swallow an action the UI asked for" philosophy as
   * `startConversation`. Rollback is attempt-scoped and title-scoped, so a
   * late failure cannot undo a newer rename or remotely refreshed title.
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
   * restores the removed row from the latest hidden v2 projection (falling
   * back to the pre-delete summary) and rethrows, except a 401, which routes
   * to `enterUnauthorized()` instead, same as every other REST call here.
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
   * Whether this client currently holds a subscription on a child — i.e.
   * whether an `accepted` frame naming that child will reach it.
   *
   * Exists for `sendToSubagent`'s `optimistic` decision (fix round 2, F3).
   * A caller that renders the child's transcript answers that question
   * structurally, by holding the subscription itself; the tasks panel does
   * not render one and never subscribes, yet it is routinely used against a
   * child SOMETHING else has open, and in that case an optimistic row is both
   * wanted and reconcilable. Asking here is how it finds out.
   *
   * For v1 this reads the desired refcount because that protocol has no
   * subscription acknowledgement. For v2 it additionally requires the
   * matching `conversation_subscribed` acknowledgement on the current child
   * socket. A desired-but-unacknowledged watch cannot receive a correlated
   * `accepted`, so treating it as live would strand an optimistic row during
   * initial connection or reconnect outages.
   *
   * A point-in-time answer. It says nothing about the window between the send
   * and the `accepted`: a row asked for while subscribed and orphaned by a
   * collapse before the echo lands is still duplicated by the next REST read
   * of that transcript (D2-era residue, see `store.test.ts`'s "the row was
   * collapsed while the steer sat on the child's queue").
   */
  isSubagentSubscribed(childId: string): boolean;
  /**
   * Types a user turn INTO a child ("type into a child's transcript", §8.3)
   * via `POST /subagents/:id/resume`.
   *
   * `optimistic` is the caller's declaration that a subscription on this
   * child is HELD — by itself or by anything else in this client. It opts
   * into a local user row in `transcripts[childId]`, marked `failed` if the
   * resume is refused and reconciled by the `accepted` frame echoing its id
   * as `requestId`.
   *
   * Off by default, and that default is the fix for round-1 I2. The echo is
   * the only correlation there is, and it only reaches a client that is
   * SUBSCRIBED to the child, so a resume sent with no subscription held left
   * a row nothing could ever reconcile, and the next expansion merged the
   * server's own copy alongside it: the user's sentence, twice.
   *
   * Round 2 (F3) unified the two callers on that one question rather than on
   * "do I render a transcript". The block answers it structurally — its
   * `open && nested` IS the condition its own subscription effect uses. The
   * tasks panel renders a list and never subscribes, but it is routinely
   * used against a child whose block is open, so it ASKS
   * (`isSubagentSubscribed`) instead of hardcoding a decline: declining there
   * cost those users their own sentence for the whole child turn, since the
   * `accepted` materialises the server's row with empty text and only the
   * `done`-triggered replay fills it in.
   * `mergeMessagesById` cannot help, because it only supersedes a row whose
   * `turnId` the incoming page carries and the local row's `turnId` is a
   * client uuid the server never saw.
   *
   * A caller that renders nothing loses nothing by declining: no row is
   * displayed, and a refusal still reaches the user through the composer's
   * own error line. What it gains is that there is no interleaving in which
   * the row can duplicate — no lifecycle, no second correlation scheme, and
   * no subscription held open across a send.
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
  sendToSubagent(childId: string, text: string, options?: { optimistic?: boolean }): Promise<void>;
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
  /** Negotiated chat protocol. Omitted by legacy callers, which remain on v1. */
  protocol?: WebChatProtocol;
  rest: MobileRestClient;
  socketFactory: (onFrame: FrameHandler, onClose: (close: ChatSocketClose) => void) => ChatSocket;
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

interface PendingV2Command {
  conversationId: string;
  expectedType: MobileV2SequencedFrame['type'];
  frame: V2CommandFrame;
  intent?: V2OrdinarySendIntent;
  resolve(frame: MobileV2SequencedFrame): void;
  reject(error: Error): void;
}

interface ActiveV2Subscription {
  id: string;
  conversationId: string;
  socket: ChatSocket;
  socketGeneration: number;
  openGeneration: number;
  resolve(): void;
  reject(error: Error): void;
}

interface ActiveV2Refresh {
  conversationId: string;
  openGeneration: number;
  promise: Promise<void>;
}

interface PendingV2Cancel {
  conversationId: string;
  openGeneration: number;
  socket: ChatSocket;
  socketGeneration: number;
}

interface V2ChildConnection {
  childId: string;
  parentId: string;
  socket: ChatSocket | null;
  subscriptionId: string | null;
  /** True only after the current socket's matching subscription acknowledgement. */
  ready: boolean;
  lastV2Seq: number;
  reconnectAttempt: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
}

function copiedImages(images: MobileImage[] | undefined): MobileImage[] | undefined {
  return images?.map((image) => ({ ...image }));
}

function commandRejectionError(
  frame: Extract<MobileV2WsServerFrame, { type: 'command_rejected' }>,
): MobileApiError {
  const status =
    frame.code === 'revision_conflict' ? 409 : frame.code === 'unauthorized' ? 401 : 400;
  return new MobileApiError(status, frame.code, {
    code: frame.code,
    error: frame.error,
    retryable: frame.retryable,
    ...(frame.details ? { details: frame.details } : {}),
  });
}

function upsertConversationSummary(
  conversations: ConversationSummary[],
  incoming: ConversationSummary,
): ConversationSummary[] {
  const index = conversations.findIndex((conversation) => conversation.id === incoming.id);
  if (index < 0) return [incoming, ...conversations];
  const next = [...conversations];
  next[index] = incoming;
  return next;
}

/**
 * A rename response owns only the title plus the revision/timestamp that
 * acknowledge that title mutation. It must not replace lifecycle or queue
 * fields that may have advanced over the socket while the PATCH was in
 * flight.
 */
function reconcileRenameSummary<T extends ConversationSummary>(
  current: T,
  updated: ConversationSummary,
): T {
  const responseIsAtLeastAsNew = updated.revision >= current.revision;
  return {
    ...current,
    title: updated.title,
    revision: Math.max(current.revision, updated.revision),
    updatedAt: responseIsAtLeastAsNew ? updated.updatedAt : current.updatedAt,
  };
}

function hasV2SummaryFields(summary: ConversationSummary): summary is MobileV2ConversationSummary {
  const candidate = summary as Partial<MobileV2ConversationSummary>;
  return (
    typeof candidate.queuePaused === 'boolean' &&
    typeof candidate.queueRevision === 'number' &&
    typeof candidate.pendingFollowUpCount === 'number' &&
    typeof candidate.v2LastSeq === 'number'
  );
}

function reconcileV2Summary(
  current: ConversationSummary,
  incoming: ConversationSummary,
  options: {
    forceIncomingTitle?: boolean;
    sequencedStateOwner?: 'current' | 'incoming';
  } = {},
): ConversationSummary {
  const currentIsV2 = hasV2SummaryFields(current);
  const incomingIsV2 = hasV2SummaryFields(incoming);
  const metadata = current.revision > incoming.revision ? current : incoming;
  let lifecycleSource: ConversationSummary | undefined;
  let queueSource: ConversationSummary | undefined;
  if (options.sequencedStateOwner === 'current' && currentIsV2) {
    lifecycleSource = current;
    queueSource = current;
  } else if (options.sequencedStateOwner === 'incoming' && incomingIsV2) {
    lifecycleSource = incoming;
    queueSource = incoming;
  } else if (currentIsV2 && incomingIsV2) {
    lifecycleSource = current.v2LastSeq > incoming.v2LastSeq ? current : incoming;
    queueSource =
      current.v2LastSeq > incoming.v2LastSeq ||
      (current.v2LastSeq === incoming.v2LastSeq && current.queueRevision > incoming.queueRevision)
        ? current
        : incoming;
  } else if (currentIsV2) {
    lifecycleSource = current;
    queueSource = current;
  } else if (incomingIsV2) {
    lifecycleSource = incoming;
    queueSource = incoming;
  }

  return {
    ...metadata,
    ...(lifecycleSource && hasV2SummaryFields(lifecycleSource)
      ? {
          status: lifecycleSource.status,
          activeTurnId: lifecycleSource.activeTurnId,
          v2LastSeq: lifecycleSource.v2LastSeq,
        }
      : {}),
    ...(queueSource && hasV2SummaryFields(queueSource)
      ? {
          queuePaused: queueSource.queuePaused,
          queueRevision: queueSource.queueRevision,
          pendingFollowUpCount: queueSource.pendingFollowUpCount,
        }
      : {}),
    ...(options.forceIncomingTitle ? { title: incoming.title } : {}),
  };
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
  const { protocol = { version: 1, capabilities: [] }, rest, socketFactory } = deps;
  const maxReconnectAttempts = deps.reconnect?.maxAttempts ?? RECONNECT_MAX_ATTEMPTS;

  let currentConversationId: string | null = null;
  let socket: ChatSocket | null = null;
  let socketGeneration = 0;
  let openGeneration = 0;
  let activeV2Subscription: ActiveV2Subscription | null = null;
  let activeV2Refresh: ActiveV2Refresh | null = null;
  const projectionEpochByConversation = new Map<string, number>();
  const pendingCommands = new Map<string, PendingV2Command>();
  const pendingCancels = new Map<string, PendingV2Cancel>();
  const deletedConversationIds = new Set<string>();
  const bootstrapRequiredConversations = new Set<string>();
  const renameAttemptByConversation = new Map<string, number>();
  const renamePendingAttemptsByConversation = new Map<string, Set<number>>();
  const renameAppliedAttemptByConversation = new Map<string, number>();
  const renameRollbackByConversation = new Map<string, ConversationSummary>();
  let conversationListRequest = 0;
  let renameAttempt = 0;
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
  /** Capable-v2 watches are one socket per expanded child, never multiplexed
   * onto the parent conversation's generation-owned command channel. */
  const v2ChildConnections = new Map<string, V2ChildConnection>();
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
  let historyRetryAttempt = 0;
  let historyRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let refreshRetryAttempt = 0;
  let refreshRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectDisabled = false;
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

  function clearHistoryRetryTimer(resetAttempt = true): void {
    if (historyRetryTimer) {
      clearTimeout(historyRetryTimer);
      historyRetryTimer = null;
    }
    if (resetAttempt) historyRetryAttempt = 0;
  }

  function clearRefreshRetryTimer(resetAttempt = true): void {
    if (refreshRetryTimer) {
      clearTimeout(refreshRetryTimer);
      refreshRetryTimer = null;
    }
    if (resetAttempt) refreshRetryAttempt = 0;
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
    function observeAuthoritativeRenameBaseline(
      conversationId: string,
      summary: ConversationSummary,
    ): void {
      if (!renamePendingAttemptsByConversation.get(conversationId)?.size) return;
      const baseline = renameRollbackByConversation.get(conversationId);
      if (!baseline) {
        renameRollbackByConversation.set(conversationId, summary);
        return;
      }
      if (protocol.version === 2) {
        renameRollbackByConversation.set(conversationId, reconcileV2Summary(baseline, summary));
      } else if (summary.revision >= baseline.revision) {
        renameRollbackByConversation.set(conversationId, summary);
      }
    }

    function installConversationPage(
      items: ConversationSummary[],
      idsAtRequestStart: ReadonlySet<string>,
    ): void {
      set((state) => {
        const incomingIds = new Set(items.map((conversation) => conversation.id));
        let v2Transcripts = state.v2Transcripts;
        const conversations = items
          .filter((conversation) => !deletedConversationIds.has(conversation.id))
          .map((conversation) => {
            observeAuthoritativeRenameBaseline(conversation.id, conversation);
            const listed = state.conversations.find((current) => current.id === conversation.id);
            if (protocol.version !== 2) {
              return renameAttemptByConversation.has(conversation.id) && listed
                ? { ...conversation, title: listed.title }
                : conversation;
            }

            const projected = state.v2Transcripts[conversation.id]?.conversation;
            const current =
              listed && projected ? reconcileV2Summary(listed, projected) : (listed ?? projected);
            let reconciled = current ? reconcileV2Summary(current, conversation) : conversation;
            if (renameAttemptByConversation.has(conversation.id) && listed) {
              reconciled = { ...reconciled, title: listed.title };
            }
            const transcript = state.v2Transcripts[conversation.id];
            if (transcript) {
              v2Transcripts = {
                ...v2Transcripts,
                [conversation.id]: {
                  ...transcript,
                  conversation: reconcileV2Summary(transcript.conversation, reconciled, {
                    sequencedStateOwner: 'current',
                  }) as MobileV2ConversationSummary,
                },
              };
            }
            return reconciled;
          });

        if (protocol.version !== 2) return { conversations };
        const additions = state.conversations.filter(
          (conversation) =>
            !idsAtRequestStart.has(conversation.id) &&
            !incomingIds.has(conversation.id) &&
            !deletedConversationIds.has(conversation.id),
        );
        return { conversations: [...additions, ...conversations], v2Transcripts };
      });
    }

    function addPendingRename(conversationId: string, attempt: number): void {
      const pending = renamePendingAttemptsByConversation.get(conversationId) ?? new Set<number>();
      pending.add(attempt);
      renamePendingAttemptsByConversation.set(conversationId, pending);
    }

    function removePendingRename(conversationId: string, attempt: number): void {
      const pending = renamePendingAttemptsByConversation.get(conversationId);
      pending?.delete(attempt);
      if (pending?.size === 0) renamePendingAttemptsByConversation.delete(conversationId);
    }

    function hasNewerRenameIntent(conversationId: string, attempt: number): boolean {
      if ((renameAppliedAttemptByConversation.get(conversationId) ?? 0) > attempt) return true;
      return [...(renamePendingAttemptsByConversation.get(conversationId) ?? [])].some(
        (pendingAttempt) => pendingAttempt > attempt,
      );
    }

    function clearSettledRenameTracking(conversationId: string): void {
      if (renamePendingAttemptsByConversation.get(conversationId)?.size) return;
      renameAttemptByConversation.delete(conversationId);
      renameAppliedAttemptByConversation.delete(conversationId);
      renameRollbackByConversation.delete(conversationId);
    }

    function restoreRenameBaseline(conversationId: string, baseline: ConversationSummary): void {
      set((state) => {
        const transcript = state.v2Transcripts[conversationId];
        return {
          conversations: state.conversations.map((conversation) =>
            conversation.id !== conversationId
              ? conversation
              : protocol.version === 2
                ? reconcileV2Summary(conversation, baseline, { forceIncomingTitle: true })
                : baseline,
          ),
          ...(transcript
            ? {
                v2Transcripts: {
                  ...state.v2Transcripts,
                  [conversationId]: {
                    ...transcript,
                    conversation: reconcileV2Summary(transcript.conversation, baseline, {
                      forceIncomingTitle: true,
                      sequencedStateOwner: 'current',
                    }) as MobileV2ConversationSummary,
                  },
                },
              }
            : {}),
        };
      });
    }

    function applyRenameSuccess(conversationId: string, updated: ConversationSummary): void {
      set((state) => {
        const transcript = state.v2Transcripts[conversationId];
        return {
          conversations: deletedConversationIds.has(conversationId)
            ? state.conversations.filter((conversation) => conversation.id !== conversationId)
            : state.conversations.map((conversation) =>
                conversation.id === conversationId
                  ? protocol.version === 2
                    ? reconcileRenameSummary(conversation, updated)
                    : updated
                  : conversation,
              ),
          ...(transcript
            ? {
                v2Transcripts: {
                  ...state.v2Transcripts,
                  [conversationId]: {
                    ...transcript,
                    conversation: reconcileRenameSummary(transcript.conversation, updated),
                  },
                },
              }
            : {}),
        };
      });
    }

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

    function installV2Transcript(
      conversationId: string,
      transcript: V2Transcript,
      preserveNewerMetadata = false,
    ): void {
      set((state) => {
        let nextTranscript = transcript;
        if (preserveNewerMetadata) {
          observeAuthoritativeRenameBaseline(conversationId, transcript.conversation);
          const projected = state.v2Transcripts[conversationId]?.conversation;
          const listed = state.conversations.find(
            (conversation) => conversation.id === conversationId,
          );
          const current =
            projected && listed ? reconcileV2Summary(listed, projected) : (projected ?? listed);
          if (current) {
            const reconciled = reconcileV2Summary(current, transcript.conversation, {
              sequencedStateOwner: 'incoming',
            });
            nextTranscript = {
              ...transcript,
              conversation: {
                ...reconciled,
                ...(renameAttemptByConversation.has(conversationId)
                  ? { title: current.title }
                  : {}),
              } as MobileV2ConversationSummary,
            };
          }
        }
        const listed = state.conversations.find(
          (conversation) => conversation.id === conversationId,
        );
        const listSummary = listed
          ? reconcileV2Summary(listed, nextTranscript.conversation)
          : nextTranscript.conversation;
        return {
          conversations: deletedConversationIds.has(conversationId)
            ? state.conversations.filter((conversation) => conversation.id !== conversationId)
            : upsertConversationSummary(state.conversations, listSummary),
          v2Transcripts: { ...state.v2Transcripts, [conversationId]: nextTranscript },
        };
      });
    }

    function updateV2Transcript(
      conversationId: string,
      updater: (transcript: V2Transcript) => V2Transcript,
    ): void {
      set((state) => {
        const current = state.v2Transcripts[conversationId];
        if (!current) return state;
        const next = updater(current);
        if (next === current) return state;
        const listed = state.conversations.find(
          (conversation) => conversation.id === conversationId,
        );
        const listSummary = listed
          ? reconcileV2Summary(listed, next.conversation)
          : next.conversation;
        return {
          v2Transcripts: { ...state.v2Transcripts, [conversationId]: next },
          conversations: deletedConversationIds.has(conversationId)
            ? state.conversations.filter((conversation) => conversation.id !== conversationId)
            : upsertConversationSummary(state.conversations, listSummary),
        };
      });
    }

    function rejectActiveSubscription(error: Error): void {
      const subscription = activeV2Subscription;
      activeV2Subscription = null;
      subscription?.reject(error);
    }

    function rejectPendingCommands(
      predicate: (command: PendingV2Command) => boolean,
      error: Error,
    ): void {
      for (const [id, command] of pendingCommands) {
        if (!predicate(command)) continue;
        pendingCommands.delete(id);
        command.reject(new Error(error.message));
      }
    }

    function recordV2Error(conversationId: string, message: string): void {
      updateV2Transcript(conversationId, (transcript) => ({
        ...transcript,
        error: { message, retryable: false },
      }));
    }

    function terminateV2CorrelationViolation(conversationId: string, frameType: string): void {
      const error = new Error(`Invalid v2 frame correlation for ${frameType}`);
      recordV2Error(conversationId, error.message);
      haltReconnectMachinery(error);
      set({ connection: 'offline' });
    }

    function currentProjectionEpoch(conversationId: string): number {
      return projectionEpochByConversation.get(conversationId) ?? 0;
    }

    function bumpProjectionEpoch(conversationId: string): number {
      const next = currentProjectionEpoch(conversationId) + 1;
      projectionEpochByConversation.set(conversationId, next);
      return next;
    }

    function operationIsCurrent(
      conversationId: string,
      generation: number,
      epoch?: number,
    ): boolean {
      return (
        !disposed &&
        currentConversationId === conversationId &&
        openGeneration === generation &&
        (epoch === undefined || currentProjectionEpoch(conversationId) === epoch)
      );
    }

    function sendV2Command<T extends MobileV2SequencedFrame>(
      conversationId: string,
      frame: V2CommandFrame,
      expectedType: T['type'],
      intent?: V2OrdinarySendIntent,
    ): Promise<T> {
      if (protocol.version !== 2 || !socket || get().connection !== 'connected') {
        return Promise.reject(
          new Error(
            'Cannot send: no connected chat socket (call openConversation() and wait for it to connect)',
          ),
        );
      }
      const attached = socket;
      return new Promise<T>((resolve, reject) => {
        pendingCommands.set(frame.id, {
          conversationId,
          expectedType,
          frame,
          intent,
          resolve: (result) => resolve(result as T),
          reject,
        });
        try {
          attached.send(frame);
        } catch {
          if (socket === attached) {
            socket = null;
            attached.close();
            set({ connection: 'reconnecting' });
            scheduleReconnect();
          }
        }
      });
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
          observeAuthoritativeRenameBaseline(conversationId, updated);
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
      const v2AgentId = get().v2Transcripts[conversationId]?.conversation.agentId;
      if (v2AgentId) return v2AgentId;
      const known = get().conversations.find((c) => c.id === conversationId)?.agentId;
      if (known) return known;
      try {
        const idsAtRequestStart = new Set(
          get().conversations.map((conversation) => conversation.id),
        );
        const page = await rest.listConversations();
        installConversationPage(page.items, idsAtRequestStart);
        return page.items.find((c) => c.id === conversationId)?.agentId ?? null;
      } catch (err) {
        if (isAuthError(err)) throw err;
        return null;
      }
    }

    async function loadOneOlderV2Page(
      conversationId: string,
      generation: number,
      epoch: number,
      attached: ChatSocket,
      attachedGeneration: number,
    ): Promise<boolean> {
      if (
        !operationIsCurrent(conversationId, generation, epoch) ||
        socket !== attached ||
        socketGeneration !== attachedGeneration
      ) {
        return false;
      }
      const cursor = get().v2Transcripts[conversationId]?.nextCursor;
      if (!cursor) return false;
      const page = await rest.getMessagesV2(conversationId, cursor);
      if (
        !operationIsCurrent(conversationId, generation, epoch) ||
        socket !== attached ||
        socketGeneration !== attachedGeneration
      ) {
        return false;
      }
      const currentCursor = get().v2Transcripts[conversationId]?.nextCursor;
      if (currentCursor !== cursor) return Boolean(currentCursor);
      updateV2Transcript(conversationId, (transcript) => prependV2MessagePage(transcript, page));
      return Boolean(page.nextCursor);
    }

    async function walkOlderV2Pages(
      conversationId: string,
      generation: number,
      epoch: number,
      attached: ChatSocket,
      attachedGeneration: number,
    ): Promise<void> {
      while (
        await loadOneOlderV2Page(conversationId, generation, epoch, attached, attachedGeneration)
      ) {
        // Each iteration re-reads the cursor from the latest projection so
        // interleaved socket frames remain authoritative.
      }
    }

    function historyOperationIsCurrent(
      conversationId: string,
      generation: number,
      epoch: number,
      attached: ChatSocket,
      attachedGeneration: number,
    ): boolean {
      return (
        operationIsCurrent(conversationId, generation, epoch) &&
        socket === attached &&
        socketGeneration === attachedGeneration
      );
    }

    function scheduleV2HistoryRetry(
      conversationId: string,
      generation: number,
      epoch: number,
      attached: ChatSocket,
      attachedGeneration: number,
    ): void {
      if (
        historyRetryTimer ||
        !get().v2Transcripts[conversationId]?.nextCursor ||
        !historyOperationIsCurrent(conversationId, generation, epoch, attached, attachedGeneration)
      ) {
        return;
      }
      const delay = reconnectDelay(historyRetryAttempt);
      historyRetryAttempt += 1;
      historyRetryTimer = setTimeout(() => {
        historyRetryTimer = null;
        if (
          !historyOperationIsCurrent(
            conversationId,
            generation,
            epoch,
            attached,
            attachedGeneration,
          )
        ) {
          return;
        }
        void continueV2History(conversationId, generation, epoch, attached, attachedGeneration);
      }, delay);
    }

    async function continueV2History(
      conversationId: string,
      generation: number,
      epoch: number,
      attached: ChatSocket,
      attachedGeneration: number,
    ): Promise<void> {
      try {
        await walkOlderV2Pages(conversationId, generation, epoch, attached, attachedGeneration);
        if (
          historyOperationIsCurrent(conversationId, generation, epoch, attached, attachedGeneration)
        ) {
          clearHistoryRetryTimer();
        }
      } catch (error) {
        if (
          !historyOperationIsCurrent(
            conversationId,
            generation,
            epoch,
            attached,
            attachedGeneration,
          )
        ) {
          return;
        }
        if (isAuthError(error)) {
          enterUnauthorized();
          return;
        }
        scheduleV2HistoryRetry(conversationId, generation, epoch, attached, attachedGeneration);
      }
    }

    function resendPendingV2Commands(conversationId: string, attached: ChatSocket): void {
      for (const command of pendingCommands.values()) {
        if (command.conversationId !== conversationId) continue;
        try {
          attached.send(command.frame);
        } catch {
          if (socket === attached) {
            socket = null;
            attached.close();
            set({ connection: 'reconnecting' });
            scheduleReconnect();
          }
          return;
        }
      }
    }

    function subscribeV2(
      conversationId: string,
      sinceV2Seq: number,
      attached: ChatSocket,
      attachedGeneration: number,
      generation: number,
    ): Promise<void> {
      rejectActiveSubscription(new Error('Conversation subscription superseded'));
      const id = crypto.randomUUID();
      const frame: MobileV2WsClientFrame = {
        type: 'subscribe_conversation',
        id,
        agentId:
          get().v2Transcripts[conversationId]?.conversation.agentId ??
          get().conversations.find((conversation) => conversation.id === conversationId)?.agentId ??
          '',
        conversationId,
        sinceV2Seq,
      };
      return new Promise<void>((resolve, reject) => {
        activeV2Subscription = {
          id,
          conversationId,
          socket: attached,
          socketGeneration: attachedGeneration,
          openGeneration: generation,
          resolve,
          reject,
        };
        try {
          attached.send(frame);
        } catch (error) {
          if (activeV2Subscription?.id === id) activeV2Subscription = null;
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    }

    function scheduleV2RefreshRetry(
      conversationId: string,
      generation: number,
      attached: ChatSocket,
      attachedGeneration: number,
    ): void {
      if (
        refreshRetryTimer ||
        !bootstrapRequiredConversations.has(conversationId) ||
        !operationIsCurrent(conversationId, generation) ||
        socket !== attached ||
        socketGeneration !== attachedGeneration
      ) {
        return;
      }
      const delay = reconnectDelay(refreshRetryAttempt);
      refreshRetryAttempt += 1;
      refreshRetryTimer = setTimeout(() => {
        refreshRetryTimer = null;
        if (
          !bootstrapRequiredConversations.has(conversationId) ||
          !operationIsCurrent(conversationId, generation) ||
          socket !== attached ||
          socketGeneration !== attachedGeneration
        ) {
          return;
        }
        void refreshV2Projection(conversationId).catch((error: unknown) => {
          if (!isAuthError(error)) {
            recordV2Error(conversationId, error instanceof Error ? error.message : String(error));
          }
        });
      }, delay);
    }

    function refreshV2Projection(conversationId: string): Promise<void> {
      if (protocol.version !== 2 || currentConversationId !== conversationId || disposed) {
        return Promise.resolve();
      }
      bootstrapRequiredConversations.add(conversationId);
      clearRefreshRetryTimer(false);
      const generation = openGeneration;
      const existing = activeV2Refresh;
      if (existing?.conversationId === conversationId && existing.openGeneration === generation) {
        return existing.promise;
      }
      clearHistoryRetryTimer();
      const epoch = bumpProjectionEpoch(conversationId);
      const promise = (async () => {
        let bootstrap: MobileV2ConversationBootstrap;
        try {
          bootstrap = await rest.bootstrap(conversationId);
        } catch (error) {
          if (isAuthError(error)) enterUnauthorized();
          throw error;
        }
        if (!operationIsCurrent(conversationId, generation, epoch)) return;
        installV2Transcript(conversationId, transcriptFromBootstrap(bootstrap), true);
        const attached = socket;
        const attachedGeneration = socketGeneration;
        if (!attached) return;
        set({ connection: 'reconnecting' });
        await subscribeV2(
          conversationId,
          bootstrap.v2ThroughSeq,
          attached,
          attachedGeneration,
          generation,
        );
        if (
          !historyOperationIsCurrent(
            conversationId,
            generation,
            epoch,
            attached,
            attachedGeneration,
          )
        ) {
          return;
        }
        bootstrapRequiredConversations.delete(conversationId);
        clearRefreshRetryTimer();
        void continueV2History(conversationId, generation, epoch, attached, attachedGeneration);
      })();
      const refresh: ActiveV2Refresh = { conversationId, openGeneration: generation, promise };
      activeV2Refresh = refresh;
      void promise.then(
        () => {
          if (activeV2Refresh === refresh) activeV2Refresh = null;
        },
        (error: unknown) => {
          if (activeV2Refresh === refresh) activeV2Refresh = null;
          const attached = socket;
          if (!isAuthError(error) && attached) {
            scheduleV2RefreshRetry(conversationId, generation, attached, socketGeneration);
          }
        },
      );
      return promise;
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
      // BEFORE the field-equality skip below, not after: the cursor is what
      // shields a later read from an earlier one that has not answered yet
      // (see the guard above). Skipping the write without bumping it would
      // let a stale response overwrite this one.
      appliedSubagentReadSeq = readSeq;
      set((state) => {
        const subagents = { ...state.subagents };
        let changed = false;
        for (const entry of entries) {
          const { id, ...facts } = entry;
          // Fix I3a: a read that says nothing new writes nothing at all.
          // Every trigger allocates a fresh entry and a fresh `facts` object
          // for every child, and one of the triggers is `done` on the open
          // conversation — so an ordinary chat with one finished child paid a
          // fresh object per assistant turn. `SubagentBlock` subscribes by
          // reference, so that re-rendered the row and its whole nested
          // transcript for no change.
          if (sameFacts(subagents[id]?.facts, facts)) continue;
          // MERGED, never assigned over: the same key carries the row's
          // `expanded` and, mid-send, its composer's `sending`.
          subagents[id] = { ...subagents[id], facts };
          changed = true;
        }
        const ids = entries.map((e) => e.id);
        const previousIds = state.subagentIds[conversationId];
        const sameIds =
          previousIds !== undefined &&
          previousIds.length === ids.length &&
          previousIds.every((id, index) => id === ids[index]);
        if (!changed && sameIds) return {};
        return {
          subagents: changed ? subagents : state.subagents,
          subagentIds: sameIds
            ? state.subagentIds
            : { ...state.subagentIds, [conversationId]: ids },
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
      for (const childId of [...v2ChildConnections.keys()]) closeV2ChildConnection(childId);
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

    function handleV1Frame(frame: MobileWsServerFrame): void {
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
        // Round-1 ruling 5, the earlier half of the `done` trigger below. A
        // NOTIFICATION turn is the gateway telling the parent that something
        // it was waiting on happened, and for this panel that something is
        // usually a background child finishing (§7.3/§8.5). The child's
        // terminal row is already persisted when the turn is enqueued
        // (`finalizeTerminal` persists before `notifications.enqueue`), so
        // there is nothing to wait for: reading here stops the row saying
        // `running` for the whole length of the turn its own finish
        // triggered. Restricted to `notification` — an ordinary user turn's
        // `accepted` says nothing about any child, and its `done` already
        // re-reads.
        if (conversationId === currentConversationId && frame.origin === 'notification') {
          void fetchSubagentList(conversationId);
        }
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
        // back, which is the panel's headline case. Paired with the
        // `accepted`/`notification` read above, which gets the same news
        // sooner; this one stays because it backstops every other trigger
        // going missing and because a child spawned DURING a turn is only
        // visible once the turn ends. One read per parent turn.
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
      // `isSubagentEvent`: that predicate also covers the retired `worker_*`
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

    function legacyChildFrame(frame: MobileV2WsServerFrame): MobileWsServerFrame | null {
      if (!('v2Seq' in frame)) return null;
      switch (frame.type) {
        case 'accepted': {
          const metadata = frame as typeof frame & {
            origin?: Extract<MobileWsServerFrame, { type: 'accepted' }>['origin'];
            kind?: Extract<MobileWsServerFrame, { type: 'accepted' }>['kind'];
            requestId?: string;
          };
          return {
            type: 'accepted',
            id: frame.runId,
            conversationId: frame.conversationId,
            userMessageId: frame.userMessageId,
            assistantMessageId: frame.assistantMessageId,
            revision: frame.revision,
            seq: frame.v2Seq,
            ...(metadata.origin ? { origin: metadata.origin } : {}),
            ...(metadata.kind ? { kind: metadata.kind } : {}),
            ...(metadata.requestId ? { requestId: metadata.requestId } : {}),
          };
        }
        case 'event':
          return {
            type: 'event',
            id: frame.runId,
            conversationId: frame.conversationId,
            seq: frame.v2Seq,
            event: frame.event,
          };
        case 'done':
          return {
            type: 'done',
            id: frame.runId,
            conversationId: frame.conversationId,
            seq: frame.v2Seq,
            ...(frame.outcome === 'cancelled' ? { outcome: 'cancelled' as const } : {}),
          };
        case 'error':
          return {
            type: 'error',
            id: frame.runId,
            conversationId: frame.conversationId,
            seq: frame.v2Seq,
            error: frame.error,
            code: frame.code,
            retryable: frame.retryable,
            activeTurnId: frame.runId,
          };
        default:
          return null;
      }
    }

    function v2ChildConnectionIsCurrent(connection: V2ChildConnection): boolean {
      return (
        !disposed &&
        v2ChildConnections.get(connection.childId) === connection &&
        currentConversationId === connection.parentId &&
        (desiredChildSubscriptions.get(connection.childId) ?? 0) > 0
      );
    }

    function closeV2ChildConnection(childId: string): void {
      const connection = v2ChildConnections.get(childId);
      if (!connection) return;
      v2ChildConnections.delete(childId);
      connection.ready = false;
      if (connection.reconnectTimer) clearTimeout(connection.reconnectTimer);
      connection.reconnectTimer = null;
      const closing = connection.socket;
      connection.socket = null;
      closing?.close();
    }

    function scheduleV2ChildReconnect(connection: V2ChildConnection): void {
      if (!v2ChildConnectionIsCurrent(connection) || connection.reconnectTimer) return;
      if (connection.reconnectAttempt >= maxReconnectAttempts) return;
      const delay = reconnectDelay(connection.reconnectAttempt);
      connection.reconnectAttempt += 1;
      connection.reconnectTimer = setTimeout(() => {
        connection.reconnectTimer = null;
        if (v2ChildConnectionIsCurrent(connection)) void connectV2Child(connection);
      }, delay);
    }

    function restartV2ChildConnection(connection: V2ChildConnection): void {
      const closing = connection.socket;
      connection.socket = null;
      connection.subscriptionId = null;
      connection.ready = false;
      closing?.close();
      scheduleV2ChildReconnect(connection);
    }

    function handleV2ChildFrame(
      connection: V2ChildConnection,
      receivingSocket: ChatSocket,
      frame: MobileV2WsServerFrame,
    ): void {
      if (!v2ChildConnectionIsCurrent(connection) || connection.socket !== receivingSocket) return;
      if (frame.type === 'conversation_subscribed') {
        if (frame.id !== connection.subscriptionId || frame.conversationId !== connection.childId) {
          restartV2ChildConnection(connection);
          return;
        }
        connection.subscriptionId = null;
        connection.ready = true;
        connection.reconnectAttempt = 0;
        return;
      }
      if (frame.type === 'command_rejected') {
        if (frame.id !== connection.subscriptionId) return;
        if (frame.code === 'unauthorized') {
          enterUnauthorized();
          return;
        }
        restartV2ChildConnection(connection);
        return;
      }
      if (!('v2Seq' in frame)) return;
      if (frame.conversationId !== connection.childId) {
        restartV2ChildConnection(connection);
        return;
      }
      if (frame.v2Seq <= connection.lastV2Seq) return;
      if (frame.v2Seq !== connection.lastV2Seq + 1) {
        void fetchChildTranscript(connection.childId);
        restartV2ChildConnection(connection);
        return;
      }
      connection.lastV2Seq = frame.v2Seq;
      const projected = legacyChildFrame(frame);
      if (projected) handleV1Frame(projected);
    }

    async function connectV2Child(connection: V2ChildConnection): Promise<void> {
      try {
        const bootstrap = await rest.bootstrap(connection.childId);
        if (!v2ChildConnectionIsCurrent(connection)) return;
        connection.lastV2Seq = bootstrap.v2ThroughSeq;
        childTranscriptIds.add(connection.childId);
        updateTranscript(connection.childId, (transcript) => ({
          ...transcript,
          messages: mergeMessagesById(transcript.messages, bootstrap.messages),
        }));
        if (bootstrap.conversation.subagent) {
          set((state) => ({
            subagents: {
              ...state.subagents,
              [connection.childId]: {
                ...state.subagents[connection.childId],
                facts: bootstrap.conversation.subagent,
              },
            },
          }));
        }

        let childSocket: ChatSocket;
        childSocket = socketFactory(
          (frame) => handleV2ChildFrame(connection, childSocket, frame as MobileV2WsServerFrame),
          (close) => {
            if (!v2ChildConnectionIsCurrent(connection) || connection.socket !== childSocket) {
              return;
            }
            connection.socket = null;
            connection.subscriptionId = null;
            connection.ready = false;
            if (
              close.kind === 'closed' &&
              (close.code === 4001 || close.reason.toLowerCase() === 'unauthorized')
            ) {
              enterUnauthorized();
              return;
            }
            scheduleV2ChildReconnect(connection);
          },
        );
        connection.socket = childSocket;
        await childSocket.connect();
        if (!v2ChildConnectionIsCurrent(connection) || connection.socket !== childSocket) {
          childSocket.close();
          return;
        }
        const id = crypto.randomUUID();
        connection.ready = false;
        connection.subscriptionId = id;
        childSocket.send({
          type: 'subscribe_conversation',
          id,
          agentId: bootstrap.conversation.agentId,
          conversationId: connection.childId,
          sinceV2Seq: bootstrap.v2ThroughSeq,
        });
      } catch (error) {
        if (!v2ChildConnectionIsCurrent(connection)) return;
        if (isAuthError(error)) {
          enterUnauthorized();
          return;
        }
        restartV2ChildConnection(connection);
      }
    }

    async function ensureV2ChildSubscription(childId: string, parentId: string): Promise<void> {
      if (v2ChildConnections.has(childId)) return;
      const connection: V2ChildConnection = {
        childId,
        parentId,
        socket: null,
        subscriptionId: null,
        ready: false,
        lastV2Seq: 0,
        reconnectAttempt: 0,
        reconnectTimer: null,
      };
      v2ChildConnections.set(childId, connection);
      await connectV2Child(connection);
    }

    function handleV2Frame(
      receivingSocket: ChatSocket,
      receivingGeneration: number,
      frame: MobileV2WsServerFrame,
    ): void {
      if (receivingSocket !== socket || receivingGeneration !== socketGeneration) return;

      if (frame.type === 'conversation_subscribed') {
        const subscription = activeV2Subscription;
        if (
          !subscription ||
          subscription.socket !== receivingSocket ||
          subscription.socketGeneration !== receivingGeneration ||
          subscription.openGeneration !== openGeneration ||
          subscription.id !== frame.id
        ) {
          return;
        }
        if (subscription.conversationId !== frame.conversationId) {
          terminateV2CorrelationViolation(subscription.conversationId, frame.type);
          return;
        }
        activeV2Subscription = null;
        reconnectAttempt = 0;
        set({ connection: 'connected' });
        resendPendingV2Commands(frame.conversationId, receivingSocket);
        subscription.resolve();
        return;
      }

      if (frame.type === 'command_rejected') {
        const subscription = activeV2Subscription;
        if (
          subscription &&
          subscription.socket === receivingSocket &&
          subscription.socketGeneration === receivingGeneration &&
          subscription.openGeneration === openGeneration &&
          subscription.id === frame.id
        ) {
          if (frame.conversationId !== subscription.conversationId) {
            terminateV2CorrelationViolation(subscription.conversationId, frame.type);
            return;
          }
          activeV2Subscription = null;
          const error = commandRejectionError(frame);
          subscription.reject(error);
          if (frame.code === 'unauthorized') enterUnauthorized();
          return;
        }

        const pending = pendingCommands.get(frame.id);
        const pendingCancel = pendingCancels.get(frame.id);
        if (
          frame.conversationId === undefined &&
          pending?.frame.type === 'message' &&
          pendingCancel?.socket === receivingSocket &&
          pendingCancel.socketGeneration === receivingGeneration &&
          pendingCancel.openGeneration === openGeneration
        ) {
          pendingCancels.delete(frame.id);
          updateV2Transcript(pendingCancel.conversationId, (transcript) => ({
            ...transcript,
            error: {
              message: frame.error,
              code: frame.code,
              retryable: frame.retryable,
              activeTurnId: frame.id,
            },
          }));
          if (frame.code === 'unauthorized') enterUnauthorized();
          return;
        }
        if (frame.conversationId === undefined && pending?.frame.type === 'message') return;
        if (pending) {
          if (frame.conversationId !== pending.conversationId) {
            terminateV2CorrelationViolation(pending.conversationId, frame.type);
            return;
          }
          pendingCommands.delete(frame.id);
          pending.reject(commandRejectionError(frame));
          if (frame.code === 'unauthorized') enterUnauthorized();
          return;
        }

        if (!pendingCancel) return;
        if (
          pendingCancel.socket !== receivingSocket ||
          pendingCancel.socketGeneration !== receivingGeneration ||
          pendingCancel.openGeneration !== openGeneration
        ) {
          return;
        }
        if (
          frame.conversationId !== undefined &&
          frame.conversationId !== pendingCancel.conversationId
        ) {
          terminateV2CorrelationViolation(pendingCancel.conversationId, frame.type);
          return;
        }
        pendingCancels.delete(frame.id);
        updateV2Transcript(pendingCancel.conversationId, (transcript) => ({
          ...transcript,
          error: {
            message: frame.error,
            code: frame.code,
            retryable: frame.retryable,
            activeTurnId: frame.id,
          },
        }));
        if (frame.code === 'unauthorized') enterUnauthorized();
        return;
      }

      if (!('v2Seq' in frame)) return;
      if (frame.conversationId !== currentConversationId) {
        if (currentConversationId) {
          terminateV2CorrelationViolation(currentConversationId, frame.type);
        }
        return;
      }
      if (frame.type === 'done' || frame.type === 'error') {
        pendingCancels.delete(frame.runId);
      }
      const transcript = get().v2Transcripts[frame.conversationId];
      if (!transcript) return;

      const frameId = frame.id;
      const pending = typeof frameId === 'string' ? pendingCommands.get(frameId) : undefined;
      const matchingPending =
        pending?.conversationId === frame.conversationId && pending.expectedType === frame.type
          ? pending
          : undefined;
      if (matchingPending && typeof frameId === 'string') {
        // Settle before reducing. On reconnect the durable transition may be
        // replayed at a cursor the projection already contains; its promise
        // still has to finish even though the reducer correctly ignores the
        // duplicate transition.
        pendingCommands.delete(frameId);
        matchingPending.resolve(frame);
      }

      let applied: { state: V2Transcript; gapAfter: number | null };
      let needsBootstrap = false;
      if (frame.type === 'accepted') {
        const reconciled = reconcileV2Accepted(transcript, frame, matchingPending?.intent);
        applied = { state: reconciled.state, gapAfter: null };
        needsBootstrap = reconciled.needsBootstrap;
      } else {
        applied = applyV2ServerFrame(transcript, frame);
      }
      if (applied.gapAfter !== null) {
        void refreshV2Projection(frame.conversationId).catch((error: unknown) => {
          if (!isAuthError(error)) {
            recordV2Error(
              frame.conversationId,
              error instanceof Error ? error.message : String(error),
            );
          }
        });
        return;
      }
      if (applied.state !== transcript) installV2Transcript(frame.conversationId, applied.state);
      if (needsBootstrap) {
        void refreshV2Projection(frame.conversationId).catch((error: unknown) => {
          if (!isAuthError(error)) {
            recordV2Error(
              frame.conversationId,
              error instanceof Error ? error.message : String(error),
            );
          }
        });
      }
    }

    function handleFrame(
      receivingSocket: ChatSocket,
      receivingGeneration: number,
      frame: MobileWsServerFrame | MobileV2WsServerFrame,
    ): void {
      if (receivingSocket !== socket || receivingGeneration !== socketGeneration) return;
      if (protocol.version === 2) {
        handleV2Frame(receivingSocket, receivingGeneration, frame as MobileV2WsServerFrame);
      } else {
        handleV1Frame(frame as MobileWsServerFrame);
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
      const generation = ++socketGeneration;
      const created: ChatSocket = socketFactory(
        (frame) => handleFrame(created, generation, frame),
        (close) => onSocketClose(created, generation, close),
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
    function haltReconnectMachinery(error = new Error('Conversation closed')): void {
      const closingConversationId = currentConversationId;
      disposed = true;
      reconnectDisabled = true;
      openGeneration += 1;
      activeV2Refresh = null;
      if (closingConversationId) bumpProjectionEpoch(closingConversationId);
      currentConversationId = null;
      clearReconnectTimer();
      clearHistoryRetryTimer();
      clearRefreshRetryTimer();
      rejectActiveSubscription(error);
      rejectPendingCommands(() => true, error);
      pendingCancels.clear();
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
      haltReconnectMachinery(new Error('Unauthorized'));
      set({ connection: 'unauthorized' });
    }

    function onSocketClose(
      closingSocket: ChatSocket,
      closingGeneration: number,
      close: ChatSocketClose,
    ): void {
      if (closingSocket !== socket) return; // stale/detached socket — already superseded, ignore.
      if (closingGeneration !== socketGeneration) return;
      const conversationId = currentConversationId;
      socket = null;
      clearHistoryRetryTimer();
      clearRefreshRetryTimer();
      pendingCancels.clear();
      activeV2Refresh = null;
      if (conversationId) bumpProjectionEpoch(conversationId);
      rejectActiveSubscription(
        new Error(close.kind === 'error' ? 'Connection error' : close.reason),
      );
      if (close.kind === 'protocol' && protocol.version === 2 && conversationId !== null) {
        recordV2Error(conversationId, close.reason);
        haltReconnectMachinery(new Error(close.reason));
        set({ connection: 'offline' });
        return;
      }
      if (
        close.kind === 'closed' &&
        (close.code === 4001 || close.reason.toLowerCase() === 'unauthorized')
      ) {
        enterUnauthorized();
        return;
      }
      if (!close.retryable) {
        const reason = close.kind === 'closed' && close.reason ? close.reason : 'Connection closed';
        haltReconnectMachinery(new Error(reason));
        set({ connection: 'offline' });
        return;
      }
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
    async function finalizeReconnectExhausted(
      conversationId: string,
      generation: number,
    ): Promise<void> {
      if (!operationIsCurrent(conversationId, generation)) return;
      try {
        await rest.identity();
        if (!operationIsCurrent(conversationId, generation)) return;
        reconnectDisabled = true;
        rejectPendingCommands(() => true, new Error('Reconnect attempts exhausted'));
        set({ connection: 'offline' });
      } catch (err) {
        if (!operationIsCurrent(conversationId, generation)) return;
        if (isAuthError(err)) {
          enterUnauthorized();
        } else {
          reconnectDisabled = true;
          rejectPendingCommands(() => true, new Error('Reconnect attempts exhausted'));
          set({ connection: 'offline' });
        }
      }
    }

    function scheduleReconnect(): void {
      if (disposed || reconnectDisabled) return;
      const conversationId = currentConversationId;
      if (reconnectTimer || !conversationId) return;
      if (reconnectAttempt >= maxReconnectAttempts) {
        void finalizeReconnectExhausted(conversationId, openGeneration);
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
      const generation = openGeneration;
      if (
        protocol.version === 2 &&
        (!get().v2Transcripts[conversationId] || bootstrapRequiredConversations.has(conversationId))
      ) {
        const epoch = bumpProjectionEpoch(conversationId);
        try {
          const bootstrap = await rest.bootstrap(conversationId);
          if (!operationIsCurrent(conversationId, generation, epoch)) return;
          installV2Transcript(conversationId, transcriptFromBootstrap(bootstrap), true);
          bootstrapRequiredConversations.delete(conversationId);
          clearRefreshRetryTimer();
        } catch (error) {
          if (!operationIsCurrent(conversationId, generation, epoch)) return;
          if (isAuthError(error)) {
            enterUnauthorized();
            return;
          }
          scheduleReconnect();
          return;
        }
      }
      const attempted = createAttachedSocket();
      const attemptedGeneration = socketGeneration;
      socket = attempted;
      try {
        await attempted.connect();
        if (!operationIsCurrent(conversationId, generation) || socket !== attempted) {
          // `dispose()` ran while `connect()` was in flight — this
          // connection is unwanted now; tear it straight back down rather
          // than resuming the turn and reporting `'connected'`.
          if (socket === attempted) socket = null;
          attempted.close();
          return;
        }
        if (protocol.version === 2) {
          const transcript = get().v2Transcripts[conversationId];
          if (!transcript) throw new Error('Conversation v2 transcript is unavailable');
          await subscribeV2(
            conversationId,
            transcript.lastAppliedV2Seq,
            attempted,
            attemptedGeneration,
            generation,
          );
          const epoch = currentProjectionEpoch(conversationId);
          await continueV2History(
            conversationId,
            generation,
            epoch,
            attempted,
            attemptedGeneration,
          );
          void fetchSubagentList(conversationId);
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
        if (!operationIsCurrent(conversationId, generation) || socket !== attempted) {
          attempted.close();
          return;
        }
        rejectActiveSubscription(err instanceof Error ? err : new Error(String(err)));
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
      rest,
      conversations: [],
      transcripts: {},
      v2Transcripts: {},
      protocol,
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
        const request = ++conversationListRequest;
        try {
          const idsAtRequestStart = new Set(
            get().conversations.map((conversation) => conversation.id),
          );
          const page = await rest.listConversations();
          if (request !== conversationListRequest) return;
          installConversationPage(page.items, idsAtRequestStart);
        } catch (err) {
          if (request !== conversationListRequest) return;
          if (isAuthError(err)) {
            enterUnauthorized();
            return;
          }
          throw err;
        }
      },

      async openConversation(conversationId: string) {
        const previousConversationId = currentConversationId;
        rejectActiveSubscription(new Error('Conversation changed'));
        rejectPendingCommands(() => true, new Error('Conversation changed'));
        if (socket) {
          const closing = socket;
          // Leaving this conversation: drop its subscription first, so a long
          // session that visits many conversations never accumulates them
          // server-side (sub-agents design 7.6).
          sendUnsubscribe();
          socket = null;
          closing.close();
        }
        // Nothing outstanding can be answered over a socket that is gone, and
        // the previous conversation's expanded children belong to it, not to
        // the one being opened.
        clearChildSubscriptions();
        subscriptionFrameIds.clear();
        clearReconnectTimer();
        clearHistoryRetryTimer();
        clearRefreshRetryTimer();
        reconnectAttempt = 0;
        reconnectDisabled = false;
        disposed = false; // a disposed store is reusable — this is a fresh connect intent.
        openGeneration += 1;
        activeV2Refresh = null;
        pendingCancels.clear();
        if (previousConversationId) bumpProjectionEpoch(previousConversationId);
        currentConversationId = conversationId;
        const generation = openGeneration;
        const epoch = bumpProjectionEpoch(conversationId);

        if (protocol.version === 2) {
          set({ connection: 'reconnecting' });
          bootstrapRequiredConversations.add(conversationId);
          let bootstrap: MobileV2ConversationBootstrap;
          try {
            bootstrap = await rest.bootstrap(conversationId);
          } catch (error) {
            if (!operationIsCurrent(conversationId, generation, epoch)) return;
            if (isAuthError(error)) {
              enterUnauthorized();
              return;
            }
            set({ connection: 'reconnecting' });
            scheduleReconnect();
            return;
          }
          if (!operationIsCurrent(conversationId, generation, epoch)) return;
          installV2Transcript(conversationId, transcriptFromBootstrap(bootstrap), true);
          bootstrapRequiredConversations.delete(conversationId);
          clearRefreshRetryTimer();
          const attached = createAttachedSocket();
          const attachedGeneration = socketGeneration;
          socket = attached;
          set({ connection: 'reconnecting' });
          try {
            await attached.connect();
            if (!operationIsCurrent(conversationId, generation, epoch) || socket !== attached) {
              if (socket === attached) socket = null;
              attached.close();
              return;
            }
            await subscribeV2(
              conversationId,
              bootstrap.v2ThroughSeq,
              attached,
              attachedGeneration,
              generation,
            );
            if (!operationIsCurrent(conversationId, generation, epoch)) return;
            await continueV2History(
              conversationId,
              generation,
              epoch,
              attached,
              attachedGeneration,
            );
            void fetchSubagentList(conversationId);
          } catch (error) {
            if (!operationIsCurrent(conversationId, generation, epoch) || socket !== attached) {
              attached.close();
              return;
            }
            rejectActiveSubscription(error instanceof Error ? error : new Error(String(error)));
            if (socket === attached) socket = null;
            attached.close();
            if (isAuthError(error)) {
              enterUnauthorized();
              return;
            }
            if (!reconnectDisabled) {
              set({ connection: 'reconnecting' });
              scheduleReconnect();
            }
          }
          return;
        }
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
        if (protocol.version === 2) {
          const transcript = get().v2Transcripts[conversationId];
          if (!transcript) throw new Error('Conversation v2 transcript is unavailable');
          if (transcript.queuePaused) {
            throw new Error('Follow Ups paused. Resume or remove them before sending.');
          }
          const submittedAt = new Date().toISOString();
          const intent: V2OrdinarySendIntent = {
            turnId,
            text,
            ...(images?.length ? { images: copiedImages(images) } : {}),
            submittedAt,
            draftRevision: 0,
          };
          const optimisticId = `optimistic:${turnId}`;
          const optimisticMessage: MobileV2ConversationMessage = {
            id: optimisticId,
            conversationId,
            turnId,
            runId: turnId,
            segmentIndex: 0,
            deliveryKind: 'normal',
            ordinal: Number.MAX_SAFE_INTEGER,
            role: 'user',
            status: 'accepted',
            content: {
              type: 'user',
              text,
              ...(images?.length ? { images: copiedImages(images) } : {}),
            },
            createdAt: submittedAt,
            updatedAt: submittedAt,
          };
          updateV2Transcript(conversationId, (current) => ({
            ...current,
            messages: {
              ...current.messages,
              [optimisticId]: optimisticMessage,
            },
            timeline: [...current.timeline, { kind: 'message', messageId: optimisticId }],
          }));
          const location = readClientLocation();
          const frame: MobileV2WsClientFrame = {
            type: 'message',
            id: turnId,
            agentId: transcript.conversation.agentId,
            channelId: CHANNEL_ID,
            conversationId,
            text,
            ...(location ? { location } : {}),
            ...(images?.length ? { images: copiedImages(images) } : {}),
            resumable: true,
          };
          try {
            await sendV2Command<Extract<MobileV2SequencedFrame, { type: 'accepted' }>>(
              conversationId,
              frame,
              'accepted',
              intent,
            );
          } catch (error) {
            updateV2Transcript(conversationId, (current) => {
              const hasTimelineEntry = current.timeline.some(
                (entry) => entry.kind === 'message' && entry.messageId === optimisticId,
              );
              return {
                ...current,
                messages: {
                  ...current.messages,
                  [optimisticId]: {
                    ...(current.messages[optimisticId] ?? optimisticMessage),
                    status: 'failed',
                  },
                },
                timeline: hasTimelineEntry
                  ? current.timeline
                  : [...current.timeline, { kind: 'message', messageId: optimisticId }],
              };
            });
            throw error;
          }
          return;
        }
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

        // Spread-omitted (never `location: undefined`) so a send from a
        // platform that reports nothing stays byte-identical to today's frame.
        const location = readClientLocation();

        const frame: MobileWsClientFrame = {
          type: 'message',
          id: turnId,
          agentId: conversation.agentId,
          channelId: CHANNEL_ID,
          conversationId,
          text,
          ...(location ? { location } : {}),
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

      async enqueueInput(conversationId, behavior, text, images) {
        const transcript = get().v2Transcripts[conversationId];
        if (protocol.version !== 2 || !transcript) {
          throw new Error('Conversation input queue unavailable');
        }
        const activeTurnId = transcript.conversation.activeTurnId;
        if (behavior === 'steer' && !activeTurnId) {
          throw new Error('The response ended before this Steer could be sent');
        }
        const frame: MobileV2WsClientFrame = {
          type: 'enqueue_input',
          id: crypto.randomUUID(),
          inputId: crypto.randomUUID(),
          agentId: transcript.conversation.agentId,
          channelId: CHANNEL_ID,
          conversationId,
          text,
          ...(images?.length ? { images: copiedImages(images) } : {}),
          behavior,
          ...(behavior === 'steer' && activeTurnId ? { expectedActiveTurnId: activeTurnId } : {}),
        };
        try {
          const accepted = await sendV2Command<
            Extract<MobileV2SequencedFrame, { type: 'input_accepted' }>
          >(conversationId, frame, 'input_accepted');
          return accepted.input;
        } catch (error) {
          if (isRevisionConflict(error)) await refreshV2Projection(conversationId);
          throw error;
        }
      },

      async editFollowUp(conversationId, inputId, expectedRevision, text, images) {
        if (protocol.version !== 2 || !get().v2Transcripts[conversationId]) {
          throw new Error('Conversation input queue unavailable');
        }
        const frame: MobileV2WsClientFrame = {
          type: 'edit_follow_up',
          id: crypto.randomUUID(),
          conversationId,
          inputId,
          expectedRevision,
          text,
          ...(images?.length ? { images: copiedImages(images) } : {}),
        };
        try {
          const updated = await sendV2Command<
            Extract<MobileV2SequencedFrame, { type: 'input_updated' }>
          >(conversationId, frame, 'input_updated');
          return updated.input;
        } catch (error) {
          if (isRevisionConflict(error)) await refreshV2Projection(conversationId);
          throw error;
        }
      },

      async removeFollowUp(conversationId, inputId, expectedRevision) {
        if (protocol.version !== 2 || !get().v2Transcripts[conversationId]) {
          throw new Error('Conversation input queue unavailable');
        }
        const frame: MobileV2WsClientFrame = {
          type: 'remove_follow_up',
          id: crypto.randomUUID(),
          conversationId,
          inputId,
          expectedRevision,
        };
        try {
          await sendV2Command<Extract<MobileV2SequencedFrame, { type: 'input_removed' }>>(
            conversationId,
            frame,
            'input_removed',
          );
        } catch (error) {
          if (isRevisionConflict(error)) await refreshV2Projection(conversationId);
          throw error;
        }
      },

      async resumeFollowUps(conversationId) {
        const transcript = get().v2Transcripts[conversationId];
        if (protocol.version !== 2 || !transcript) {
          throw new Error('Conversation input queue unavailable');
        }
        const frame: MobileV2WsClientFrame = {
          type: 'resume_follow_ups',
          id: crypto.randomUUID(),
          conversationId,
          expectedQueueRevision: transcript.queueRevision,
        };
        try {
          await sendV2Command<Extract<MobileV2SequencedFrame, { type: 'queue_resumed' }>>(
            conversationId,
            frame,
            'queue_resumed',
          );
        } catch (error) {
          if (isRevisionConflict(error)) await refreshV2Projection(conversationId);
          throw error;
        }
      },

      async loadOlderMessages(conversationId) {
        if (protocol.version !== 2) return;
        const generation = openGeneration;
        const epoch = currentProjectionEpoch(conversationId);
        const attached = socket;
        const attachedGeneration = socketGeneration;
        if (!attached) return;
        try {
          await loadOneOlderV2Page(conversationId, generation, epoch, attached, attachedGeneration);
        } catch (error) {
          if (isAuthError(error)) {
            enterUnauthorized();
            return;
          }
          throw error;
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
        const attempt = ++renameAttempt;
        addPendingRename(conversationId, attempt);
        if (!renameRollbackByConversation.has(conversationId)) {
          renameRollbackByConversation.set(conversationId, target);
        }
        renameAttemptByConversation.set(conversationId, attempt);

        set((state) => {
          const transcript = state.v2Transcripts[conversationId];
          return {
            conversations: state.conversations.map((conversation) =>
              conversation.id === conversationId ? { ...conversation, title } : conversation,
            ),
            ...(transcript
              ? {
                  v2Transcripts: {
                    ...state.v2Transcripts,
                    [conversationId]: {
                      ...transcript,
                      conversation: { ...transcript.conversation, title },
                    },
                  },
                }
              : {}),
          };
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
            if (hasNewerRenameIntent(conversationId, attempt)) throw err;
            const fresh = await rest.getConversation(conversationId);
            observeAuthoritativeRenameBaseline(conversationId, fresh);
            if (hasNewerRenameIntent(conversationId, attempt)) throw err;
            updated = await rest.patchConversation(conversationId, { title }, fresh.revision);
          }
          const lastApplied = renameAppliedAttemptByConversation.get(conversationId) ?? 0;
          if (attempt >= lastApplied) {
            const baseline = renameRollbackByConversation.get(conversationId);
            renameRollbackByConversation.set(
              conversationId,
              protocol.version === 2 && baseline
                ? reconcileRenameSummary(baseline, updated)
                : updated,
            );
            renameAppliedAttemptByConversation.set(conversationId, attempt);
          }
          removePendingRename(conversationId, attempt);
          if (!hasNewerRenameIntent(conversationId, attempt))
            applyRenameSuccess(conversationId, updated);
          if (renameAttemptByConversation.get(conversationId) === attempt) {
            renameAttemptByConversation.delete(conversationId);
          }
          clearSettledRenameTracking(conversationId);
        } catch (err) {
          removePendingRename(conversationId, attempt);
          if (renameAttemptByConversation.get(conversationId) === attempt) {
            renameAttemptByConversation.delete(conversationId);
            restoreRenameBaseline(
              conversationId,
              renameRollbackByConversation.get(conversationId) ?? target,
            );
          }
          clearSettledRenameTracking(conversationId);
          if (isAuthError(err)) {
            enterUnauthorized();
            return;
          }
          throw err;
        }
      },

      async deleteConversation(conversationId) {
        const previous = get().conversations;
        const targetIndex = previous.findIndex(
          (conversation) => conversation.id === conversationId,
        );
        const target = previous[targetIndex];
        if (!target) return;

        let rollbackSummary = target;
        deletedConversationIds.add(conversationId);
        set({ conversations: previous.filter((c) => c.id !== conversationId) });
        try {
          try {
            await rest.deleteConversation(conversationId, target.revision);
          } catch (err) {
            // Fix C1c: same stale-`revision` retry-once as renameConversation.
            if (!isRevisionConflict(err)) throw err;
            const fresh = await rest.getConversation(conversationId);
            observeAuthoritativeRenameBaseline(conversationId, fresh);
            if (fresh.revision >= rollbackSummary.revision) rollbackSummary = fresh;
            await rest.deleteConversation(conversationId, fresh.revision);
          }
        } catch (err) {
          deletedConversationIds.delete(conversationId);
          set((state) => {
            if (state.conversations.some((conversation) => conversation.id === conversationId)) {
              return state;
            }
            const restored = [...state.conversations];
            const transcript = state.v2Transcripts[conversationId];
            const projected = transcript?.conversation;
            const restoredSummary = projected
              ? reconcileV2Summary(projected, rollbackSummary)
              : rollbackSummary;
            restored.splice(Math.min(targetIndex, restored.length), 0, restoredSummary);
            return {
              conversations: restored,
              ...(transcript
                ? {
                    v2Transcripts: {
                      ...state.v2Transcripts,
                      [conversationId]: {
                        ...transcript,
                        conversation: reconcileV2Summary(transcript.conversation, restoredSummary, {
                          sequencedStateOwner: 'current',
                        }) as MobileV2ConversationSummary,
                      },
                    },
                  }
                : {}),
            };
          });
          if (isAuthError(err)) {
            enterUnauthorized();
            return;
          }
          throw err;
        }
        set((state) => {
          const { [conversationId]: _v2Transcript, ...v2Transcripts } = state.v2Transcripts;
          const { [conversationId]: _transcript, ...transcripts } = state.transcripts;
          return {
            conversations: state.conversations.filter(
              (conversation) => conversation.id !== conversationId,
            ),
            v2Transcripts,
            transcripts,
          };
        });
        bootstrapRequiredConversations.delete(conversationId);
        renameAttemptByConversation.delete(conversationId);
        renamePendingAttemptsByConversation.delete(conversationId);
        renameAppliedAttemptByConversation.delete(conversationId);
        renameRollbackByConversation.delete(conversationId);
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
        const parentId = currentConversationId;
        if (protocol.version === 2) {
          if (parentId) void ensureV2ChildSubscription(childId, parentId);
          return;
        }
        // OPTIMISATION, not a correctness guard: the watcher outlived the
        // release (see `unsubscribeSubagent`), so the socket already carries
        // this child and there is no `resolveAgentId` round trip to pay for.
        // Removing this line changes no outcome — `flushChildSubscriptions`
        // skips any child already in `activeChildSubscriptions` on its own.
        if (activeChildSubscriptions.has(childId)) return;
        if (!socket || !parentId) return;
        void flushChildSubscriptions(socket, parentId);
      },

      isSubagentSubscribed(childId) {
        if (!desiredChildSubscriptions.has(childId)) return false;
        if (protocol.version !== 2) return true;
        return v2ChildConnections.get(childId)?.ready === true;
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
          if (protocol.version === 2) {
            closeV2ChildConnection(childId);
            return;
          }
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
       * Everything below is about the OPTIMISTIC row, which only exists when
       * the caller opted in (see `WebAppState.sendToSubagent`). Without it
       * the method is a bare REST call: nothing local to reconcile, nothing
       * to withdraw, no `requestId`.
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
      async sendToSubagent(childId, text, options) {
        // Fix I2: no row unless the caller asked for one. A caller that
        // renders no transcript is not subscribed to the child either, so
        // there is no `accepted` coming to reconcile a row it would write —
        // and an unreconciled row is duplicated by the next REST read of that
        // transcript. `undefined` rather than a uuid nothing can ever match:
        // on this path the row's id IS the correlation id, so with no row
        // there is nothing to correlate. The gateway treats an absent
        // `requestId` as "uncorrelated" by contract.
        let localId: string | undefined;
        if (options?.optimistic) {
          // Registered only when something is actually written, so
          // `clearChildSubscriptions` has no dead ids to walk.
          childTranscriptIds.add(childId);
          // The optimistic row goes in FIRST so the text is visible in the
          // child's transcript while the resume is in flight, and so there is
          // something to mark `failed` if it is refused. Its id doubles as the
          // request's correlation id.
          localId = crypto.randomUUID();
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
        }

        try {
          await rest.resumeSubagent(childId, text, localId);
        } catch (err) {
          if (localId !== undefined) {
            const failedId = localId;
            updateTranscript(childId, (t) => ({
              ...t,
              messages: t.messages.map((m) =>
                m.id === failedId ? { ...m, status: 'failed' as const } : m,
              ),
            }));
          }
          if (isAuthError(err)) enterUnauthorized();
          // Rethrown, unlike `cancelTurn`'s swallow: the user typed this and it
          // did not reach the agent, so the row that owns the composer has to
          // say so.
          throw err;
        }

        if (localId === undefined) return;
        // The send succeeded, so the row must not sit at `accepted` for the
        // life of the store waiting for a frame that may be minutes away or
        // may never come (path 3). A no-op if the `accepted` already beat us
        // here: reconciliation renamed the row to the server's id.
        const sentId = localId;
        updateTranscript(childId, (t) => ({
          ...t,
          messages: t.messages.map((m) =>
            m.id === sentId && m.status === 'accepted' ? { ...m, status: 'completed' as const } : m,
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
        const turnId =
          protocol.version === 2
            ? get().v2Transcripts[conversationId]?.conversation.activeTurnId
            : get().transcripts[conversationId]?.pending?.turnId;
        if (!turnId) return;
        const frame: MobileWsClientFrame = { type: 'cancel', id: turnId };
        try {
          if (protocol.version === 2) {
            pendingCancels.set(turnId, {
              conversationId,
              openGeneration,
              socket,
              socketGeneration,
            });
          }
          socket.send(frame);
        } catch (err) {
          pendingCancels.delete(turnId);
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
