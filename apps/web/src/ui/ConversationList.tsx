import type { ConversationSummary, MobileAgent } from '@dash/mobile-contract';
import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useWebAppStore } from './Shell.js';

export interface ConversationListProps {
  selectedConversationId: string | null;
  onSelect: (conversationId: string) => void;
  /**
   * Fired once a delete actually succeeds (chat-ux Phase 3 Task 1, audit
   * #8), with the deleted conversation's id. This component doesn't own
   * `selectedConversationId` — `Shell` does — so clearing it when the
   * deleted row was the open conversation is the caller's job; `ChatView`
   * already renders a plain "Select a conversation" empty state for a
   * `null` `conversationId`, so `Shell` doing that is safe. Optional so
   * `ConversationList`'s own tests can render without it.
   */
  onConversationDeleted?: (conversationId: string) => void;
  /**
   * Chat-ux Phase 3 Task 5 (web keyboard shortcuts, MC parity): lets
   * `Shell`'s global Cmd/Ctrl+K handler focus the search input directly,
   * without lifting the query into `Shell`'s own state — same
   * "parent-owns-a-ref, child attaches it" idiom `ChatView`/`MessageEditor`
   * already use for autofocus, just handed in from outside instead of
   * created locally. Optional so `ConversationList`'s own tests (and any
   * render without a keyboard-shortcut owner) don't need to pass one.
   */
  searchInputRef?: RefObject<HTMLInputElement | null>;
  /**
   * Chat-ux Phase 3 Task 5: `Shell`'s global Cmd/Ctrl+Shift+O handler
   * reuses THIS component's own "New conversation" flow (agent
   * fetch/skip-the-picker-if-there's-one/picker) instead of duplicating it
   * — `ConversationList` keeps this ref pointed at its latest
   * `handleNewConversation` closure (see the effect below) so `Shell` can
   * invoke it imperatively without either component needing to know the
   * other's internals.
   */
  newConversationRef?: RefObject<(() => void) | null>;
}

/** Exact copy shown when the store's `conversations` list is empty. */
export const NO_CONVERSATIONS_COPY = 'No conversations yet.';

/** Exact copy shown on the "start a new conversation" button. */
export const NEW_CONVERSATION_LABEL = 'New conversation';

/** Accessibility id for the "New conversation" button, following the same
 * dotted `<area>.<action>` naming the iOS app uses for its
 * `accessibilityIdentifier`s (`conversation.new`, `chat.composer`, ...) —
 * expressed here as `data-testid` since that's this app's existing
 * test-hook idiom (see `data-testid="chat-message"` in `ChatView`). */
export const NEW_CONVERSATION_TESTID = 'chat.new-conversation';

/** Copy shown when an account has no agents at all, so there is nothing to
 * start a new conversation with — kept distinct from a REST failure. */
export const NO_AGENTS_COPY = 'No agents available to start a conversation.';

/** aria-label on the search input (chat-ux Phase 3 Task 1, audit #8). */
export const SEARCH_INPUT_LABEL = 'Search conversations';

/** Copy shown when a search query matches none of the loaded conversations
 * — distinct from `NO_CONVERSATIONS_COPY` (an empty account, not a filter
 * that happens to match nothing). */
export const NO_SEARCH_RESULTS_COPY = 'No conversations match your search.';

/** aria-label on the per-row rename affordance — exact copy per the task brief. */
export const RENAME_ACTION_LABEL = 'Rename conversation';

/** aria-label on the per-row delete affordance. */
export const DELETE_ACTION_LABEL = 'Delete conversation';

/** aria-label on the rename row's text input, once it replaces the title. */
export const RENAME_INPUT_LABEL = 'Conversation title';

/** Exact copy for the inline delete-confirm — never `window.confirm()` (not
 * stylable, not reduce-motion-gated, and inconsistent with the rest of this
 * app's dialogs), a small two-button inline confirm instead. */
export const DELETE_CONFIRM_COPY = "Delete this conversation? This can't be undone.";

/** Number of placeholder rows shown while `loadConversations()` is in
 * flight (chat-ux Phase 3 Task 4, audit #13 remainder) — just enough to
 * plausibly fill the sidebar without implying a specific real count. */
const SKELETON_ROW_COUNT = 5;

/** `data-testid` on the skeleton container, for tests. */
export const CONVERSATION_SKELETON_TESTID = 'conversation-skeleton';

/** Placeholder rows shown in place of the conversation list while its
 * initial load is in flight — never alongside `NO_CONVERSATIONS_COPY` or
 * the real rows (see `ConversationList`'s `isLoading` gate). `aria-hidden`:
 * this is decorative filler, not content a screen reader should announce. */
function ConversationSkeletonRows(): ReactNode {
  return (
    <ul
      className="conversation-items"
      aria-hidden="true"
      data-testid={CONVERSATION_SKELETON_TESTID}
    >
      {Array.from({ length: SKELETON_ROW_COUNT }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length decorative placeholder, never reordered/filtered
        <li key={i} className="conversation-skeleton-row">
          <span className="conversation-skeleton-line conversation-skeleton-line--title" />
          <span className="conversation-skeleton-line conversation-skeleton-line--preview" />
        </li>
      ))}
    </ul>
  );
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : 'Failed to start a new conversation.';
}

function describeMutationError(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

/** Final-review fix I4: the destructive delete-confirm's `aria-label`,
 * naming the specific conversation (same title-or-agent-name fallback the
 * row itself renders) so a screen reader announces which conversation is
 * about to be deleted rather than an identical, unqualified label for
 * every row's confirm. */
function deleteConfirmLabel(conversation: ConversationSummary): string {
  return `Delete "${conversation.title || conversation.agentName}"?`;
}

/** Local-only filter (chat-ux Phase 3 Task 1, audit #8): case-insensitive
 * substring match against title (falling back to the agent name, same as
 * what the row itself displays when there's no title) and the last-message
 * preview. Never touches the store/REST — `conversations` is already
 * loaded. */
function matchesSearch(conversation: ConversationSummary, query: string): boolean {
  if (!query) return true;
  const haystack = `${conversation.title || conversation.agentName} ${
    conversation.lastMessagePreview ?? ''
  }`.toLowerCase();
  return haystack.includes(query);
}

/**
 * Sidebar list of the account's conversations, sourced from
 * `useWebAppStore()` (the Task 11 store Shell creates per gateway). Triggers
 * `loadConversations()` once on mount — the store itself never fetches
 * eagerly — and lets the parent (`Shell`'s chat workspace) own which
 * conversation is "selected" so it can also drive `ChatView`.
 *
 * Also owns the "New conversation" flow: fetch the account's agents via the
 * store's `listAgents()`, skip straight past the picker when there's exactly
 * one, otherwise let the user choose one from a simple list, then hand the
 * chosen `agentId` to the store's `startConversation()` (which creates the
 * conversation via REST and opens it) and select the result. Any REST
 * failure along the way is surfaced inline rather than swallowed.
 *
 * Conversation management (chat-ux Phase 3 Task 1, audit #8): a local-only
 * search box filters the rendered list by title/preview; each row reveals
 * rename/delete affordances on hover or keyboard focus (`.conversation-row-wrap`'s
 * `:hover`/`:focus-within` in `styles.css`, same reveal pattern as
 * `ChatView`'s message-action toolbar) so they're reachable without a mouse.
 * Rename replaces the row's title with an inline text input (Enter commits
 * via the store's `renameConversation`, Escape cancels). Delete opens a
 * small inline two-button confirm — never `window.confirm()` — and calls
 * the store's `deleteConversation` on confirmation.
 */
export function ConversationList({
  selectedConversationId,
  onSelect,
  onConversationDeleted,
  searchInputRef,
  newConversationRef,
}: ConversationListProps) {
  const useAppStore = useWebAppStore();
  const conversations = useAppStore((s) => s.conversations);
  const connection = useAppStore((s) => s.connection);
  const loadConversations = useAppStore((s) => s.loadConversations);
  const listAgents = useAppStore((s) => s.listAgents);
  const startConversation = useAppStore((s) => s.startConversation);
  const renameConversation = useAppStore((s) => s.renameConversation);
  const deleteConversation = useAppStore((s) => s.deleteConversation);

  const [agentChoices, setAgentChoices] = useState<MobileAgent[] | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * Final-review fix I1: a synchronous reentrancy guard for
   * `handleNewConversation`, armed BEFORE its first `await` — mirrors iOS's
   * `isComposing` guard in `ConversationListView.swift`'s `startCompose`
   * ("Armed BEFORE the first await below: ... a second tap landing in that
   * window would otherwise pass the reentrancy guard"). The `busy` STATE
   * variable above isn't sufficient on its own: `newConversationRef.current?.()`
   * (Shell's Cmd/Ctrl+Shift+O handler, and its key-repeat) calls
   * `handleNewConversation` directly, bypassing the "New conversation"
   * button's `disabled={busy}` — and `setBusy(true)`'s update hasn't
   * committed yet by the time a second, synchronous invocation in the same
   * tick would read `busy` via closure. A plain ref read/write is
   * synchronous, so it closes that window regardless of caller.
   */
  const newConversationBusyRef = useRef(false);
  /** Final-review fix I4: per-row refs to each Delete affordance, keyed by
   * conversation id, so closing the destructive confirm (via Cancel, Escape,
   * or a failed delete) can restore focus to the exact button that opened
   * it instead of leaving focus stranded on a fieldset that just unmounted. */
  const deleteButtonRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  /** Fix I4: mirrors whatever `searchInputRef` (a prop `Shell` also reaches
   * into for its own Cmd/Ctrl+K handling) points at, but always populated —
   * unlike the prop, which is optional — so this component can manage its
   * OWN post-delete focus target without depending on a caller having
   * supplied one. See the combined ref callback on the `<input>` below. */
  const internalSearchInputRef = useRef<HTMLInputElement | null>(null);
  /** Fix I4: focus fallback when the search input isn't rendered (an empty
   * `conversations` list) — the `<nav>` itself, made programmatically
   * focusable via `tabIndex={-1}` below. */
  const listContainerRef = useRef<HTMLElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  // Skeleton rows (chat-ux Phase 3 Task 4, audit #13 remainder): true only
  // for the FIRST `loadConversations()` round-trip this component instance
  // ever kicks off — not re-armed on every mount/prop change, since this
  // effect's own `[loadConversations]` dependency is stable for a given
  // store (a component-level flag, not derived from the store, because the
  // store itself has no "am I loading" field of its own; see
  // `state/store.ts`'s `WebAppState` — nothing else needs one yet). `mounted`
  // guards the `finally` against setting state after an unmount that
  // happens to race a slow REST call.
  // Minor 4 (Phase 4): seeded from whether the store ALREADY holds conversations
  // rather than unconditionally `true`. `loadConversations()` below still runs on
  // every mount (it refreshes), but a remount over a warm store — returning from
  // the Devices screen, say — must not flash skeletons over a list that is
  // already on screen. An empty store still starts in the loading state, so a
  // genuine first load is unchanged.
  const [isLoading, setIsLoading] = useState(() => conversations.length === 0);

  useEffect(() => {
    let mounted = true;
    void loadConversations().finally(() => {
      if (mounted) setIsLoading(false);
    });
    return () => {
      mounted = false;
    };
  }, [loadConversations]);

  async function createWithAgent(agentId: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const created = await startConversation(agentId);
      setAgentChoices(null);
      onSelect(created.id);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleNewConversation(): Promise<void> {
    // Fix I1: see `newConversationBusyRef`'s doc comment — checked and armed
    // synchronously, before `listAgents()`'s `await`, so three rapid
    // invocations (key-repeat on Cmd/Ctrl+Shift+O, or any other reentrant
    // caller) can only ever let the first one through.
    if (newConversationBusyRef.current) return;
    newConversationBusyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const agents = await listAgents();
      if (agents.length === 0) {
        setError(NO_AGENTS_COPY);
        return;
      }
      if (agents.length === 1) {
        await createWithAgent(agents[0].id);
        return;
      }
      setAgentChoices(agents);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
      newConversationBusyRef.current = false;
    }
  }

  // Keeps `newConversationRef` pointed at the CURRENT `handleNewConversation`
  // closure (it captures `listAgents`/`startConversation`/`onSelect`, which
  // are stable across renders, but re-running this after every render — no
  // dependency array — is what makes this safe against ever going stale
  // without needing to think about it). A ref write, not state: it must not
  // itself trigger a re-render.
  useEffect(() => {
    if (newConversationRef) {
      newConversationRef.current = () => {
        void handleNewConversation();
      };
    }
  });

  function startRename(conversation: ConversationSummary): void {
    setConfirmingDeleteId(null);
    setError(null);
    setEditingId(conversation.id);
    setEditValue(conversation.title || conversation.agentName);
  }

  function cancelRename(): void {
    setEditingId(null);
  }

  async function commitRename(conversation: ConversationSummary): Promise<void> {
    const title = editValue.trim();
    setEditingId(null);
    if (!title || title === conversation.title) return;
    try {
      await renameConversation(conversation.id, title);
    } catch (err) {
      setError(describeMutationError(err, 'Failed to rename conversation.'));
    }
  }

  function handleRenameKeyDown(
    event: KeyboardEvent<HTMLInputElement>,
    conversation: ConversationSummary,
  ): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      void commitRename(conversation);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      // Final-review fix I2 (belt+suspenders): `Shell`'s own Escape handler
      // already bails out for any focus target inside `.conversation-list`
      // (which this input is), so this shouldn't be reachable in practice —
      // but stopping propagation here too means this Escape can never be
      // misrouted to `Shell`'s `cancelTurn` even if that bail-out is ever
      // narrowed or reordered.
      event.stopPropagation();
      cancelRename();
    }
  }

  /** Final-review fix I2/I4: closes the delete confirm WITHOUT deleting —
   * shared by the confirm's own Cancel button and its Escape handling (see
   * `handleDeleteConfirmKeyDown`) — and restores focus to the row's own
   * Delete affordance (I4) rather than leaving focus stranded on a button
   * that's about to unmount. */
  function cancelDeleteConfirm(conversationId: string): void {
    setConfirmingDeleteId(null);
    deleteButtonRefs.current.get(conversationId)?.focus();
  }

  function handleDeleteConfirmKeyDown(
    event: KeyboardEvent<HTMLFieldSetElement>,
    conversation: ConversationSummary,
  ): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      // Fix I2: Escape here means "dismiss the confirm", not "cancel the
      // in-flight turn" — stop it from ever reaching `Shell`'s window-level
      // Escape handler (which would otherwise also see it and, while
      // streaming, call `cancelTurn`; see `Shell.tsx`'s widened bail-out for
      // the belt side of this belt+suspenders pair).
      event.stopPropagation();
      cancelDeleteConfirm(conversation.id);
    }
  }

  async function confirmDelete(conversation: ConversationSummary): Promise<void> {
    setConfirmingDeleteId(null);
    try {
      await deleteConversation(conversation.id);
      onConversationDeleted?.(conversation.id);
      // Fix I4: focus somewhere still on the page rather than letting it
      // fall back to <body> now that the confirm (and possibly the whole
      // row) is gone. The search input only renders while `conversations`
      // is non-empty (see the render below) — reading the STORE's live
      // state (not the `conversations` render-closure value, which is
      // stale until the next render commits) tells us which is about to be
      // true once this delete's removal lands.
      if (useAppStore.getState().conversations.length > 0) {
        internalSearchInputRef.current?.focus();
      } else {
        listContainerRef.current?.focus();
      }
    } catch (err) {
      setError(describeMutationError(err, 'Failed to delete conversation.'));
      // The confirm already closed (optimistically, above) even though the
      // delete failed — same focus-restore as an explicit Cancel, so focus
      // never just vanishes into the fieldset that unmounted under it.
      deleteButtonRefs.current.get(conversation.id)?.focus();
    }
  }

  // C4: when the connection is unreachable ('offline') or the credential was
  // rejected ('unauthorized'), ChatView's banner already owns the screen —
  // showing "No conversations yet." alongside it would misdescribe a
  // transport/credential problem as an empty account.
  const suppressEmptyCopy = connection === 'offline' || connection === 'unauthorized';

  const normalizedQuery = query.trim().toLowerCase();
  const visibleConversations = useMemo(
    () => conversations.filter((c) => matchesSearch(c, normalizedQuery)),
    [conversations, normalizedQuery],
  );

  return (
    <nav
      aria-label="Conversations"
      className="conversation-list"
      // Fix I4: a focus target of last resort once a delete leaves the
      // account empty (no search input to fall back to) — `tabIndex={-1}`
      // makes a non-interactive element programmatically focusable without
      // adding it to the Tab order.
      tabIndex={-1}
      ref={listContainerRef}
    >
      {/* Minor 1 (Phase 4): rendered unconditionally — NOT gated on
          `conversations.length > 0`. While gated, Cmd/Ctrl+K had no target on an
          empty account and throughout the initial load, so it was a silent no-op
          that still flipped `sidebarOpen` on desktop, leaving the next Escape to
          be consumed "closing" a drawer that is `display:none` above 768px.
          Claude and ChatGPT both keep search as permanent sidebar chrome, which
          removes the failure class instead of special-casing the shortcut. */}
      <input
        ref={(el) => {
          internalSearchInputRef.current = el;
          if (searchInputRef) searchInputRef.current = el;
        }}
        type="search"
        aria-label={SEARCH_INPUT_LABEL}
        placeholder={SEARCH_INPUT_LABEL}
        title="⌘K"
        className="conversation-search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />

      <button
        type="button"
        data-testid={NEW_CONVERSATION_TESTID}
        onClick={() => void handleNewConversation()}
        disabled={busy}
        title="⌘⇧O"
        className="conversation-new-button"
      >
        {NEW_CONVERSATION_LABEL}
      </button>

      {agentChoices && agentChoices.length > 1 && (
        <ul aria-label="Choose an agent" className="conversation-agent-list">
          {agentChoices.map((agent) => (
            <li key={agent.id}>
              <button
                type="button"
                onClick={() => void createWithAgent(agent.id)}
                disabled={busy}
                className="conversation-agent-choice"
              >
                {agent.name}
              </button>
            </li>
          ))}
        </ul>
      )}

      {error && <p role="alert">{error}</p>}

      {isLoading ? (
        suppressEmptyCopy ? null : (
          <ConversationSkeletonRows />
        )
      ) : conversations.length === 0 ? (
        suppressEmptyCopy ? null : (
          <p className="conversation-empty">{NO_CONVERSATIONS_COPY}</p>
        )
      ) : visibleConversations.length === 0 ? (
        <p className="conversation-empty">{NO_SEARCH_RESULTS_COPY}</p>
      ) : (
        <ul className="conversation-items">
          {visibleConversations.map((conversation) => {
            const isSelected = conversation.id === selectedConversationId;
            const isEditing = editingId === conversation.id;
            const isConfirmingDelete = confirmingDeleteId === conversation.id;
            return (
              <li key={conversation.id} className="conversation-row-wrap">
                <div className="conversation-row-line">
                  {isEditing ? (
                    <input
                      aria-label={RENAME_INPUT_LABEL}
                      className="conversation-row conversation-row-rename-input"
                      value={editValue}
                      // biome-ignore lint/a11y/noAutofocus: entering rename mode should focus the input
                      autoFocus
                      onChange={(event) => setEditValue(event.target.value)}
                      onKeyDown={(event) => handleRenameKeyDown(event, conversation)}
                      // Minor 3 (Phase 4): blur CANCELS. Without this the row
                      // stayed a live text input after a click elsewhere — and
                      // an editing row renders no button, so the conversation
                      // could not be opened until the user found Enter or Esc.
                      // Cancel rather than commit: a blur is not a confirmation,
                      // and silently saving a half-typed title on an accidental
                      // click away is the worse failure. Escape's behaviour
                      // (`handleRenameKeyDown`) is the one this matches.
                      onBlur={cancelRename}
                    />
                  ) : (
                    <button
                      type="button"
                      aria-current={isSelected ? 'true' : undefined}
                      onClick={() => onSelect(conversation.id)}
                      className="conversation-row"
                    >
                      <div className="conversation-row-title">
                        {conversation.title || conversation.agentName}
                      </div>
                      {conversation.lastMessagePreview && (
                        <div className="conversation-row-preview">
                          {conversation.lastMessagePreview}
                        </div>
                      )}
                    </button>
                  )}

                  {!isEditing && (
                    <div className="conversation-row-actions">
                      <button
                        type="button"
                        aria-label={RENAME_ACTION_LABEL}
                        className="conversation-row-action"
                        onClick={(event) => {
                          event.stopPropagation();
                          startRename(conversation);
                        }}
                      >
                        Rename
                      </button>
                      <button
                        type="button"
                        aria-label={DELETE_ACTION_LABEL}
                        className="conversation-row-action"
                        // Fix I4: recorded so `cancelDeleteConfirm`/a failed
                        // delete can send focus back here.
                        ref={(el) => {
                          if (el) deleteButtonRefs.current.set(conversation.id, el);
                          else deleteButtonRefs.current.delete(conversation.id);
                        }}
                        onClick={(event) => {
                          event.stopPropagation();
                          setEditingId(null);
                          setConfirmingDeleteId(conversation.id);
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  )}
                </div>

                {isConfirmingDelete && (
                  <fieldset
                    className="conversation-delete-confirm"
                    // Fix I4: an unannounced inline confirm for a
                    // destructive action is a trap for screen-reader users —
                    // `alertdialog` (not plain `dialog`) since this demands
                    // an immediate decision, same semantics as a native
                    // confirm. The label names the conversation so it reads
                    // distinctly from every other row's identical confirm.
                    role="alertdialog"
                    aria-label={deleteConfirmLabel(conversation)}
                    onKeyDown={(event) => handleDeleteConfirmKeyDown(event, conversation)}
                  >
                    <p>{DELETE_CONFIRM_COPY}</p>
                    <button
                      type="button"
                      className="conversation-delete-confirm-delete"
                      onClick={() => void confirmDelete(conversation)}
                    >
                      Delete
                    </button>
                    <button
                      type="button"
                      className="conversation-delete-confirm-cancel"
                      // Fix I4: focus moves here the moment the confirm
                      // opens — the safer of the two actions, and where a
                      // screen-reader user lands ready to hear the alert.
                      // biome-ignore lint/a11y/noAutofocus: opening a destructive confirm should focus its safe (Cancel) action
                      autoFocus
                      onClick={() => cancelDeleteConfirm(conversation.id)}
                    >
                      Cancel
                    </button>
                  </fieldset>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </nav>
  );
}

export default ConversationList;
