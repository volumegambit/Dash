import type { ConversationSummary, MobileAgent } from '@dash/mobile-contract';
import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useMemo,
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
  const [isLoading, setIsLoading] = useState(true);

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
      cancelRename();
    }
  }

  async function confirmDelete(conversation: ConversationSummary): Promise<void> {
    setConfirmingDeleteId(null);
    try {
      await deleteConversation(conversation.id);
      onConversationDeleted?.(conversation.id);
    } catch (err) {
      setError(describeMutationError(err, 'Failed to delete conversation.'));
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
    <nav aria-label="Conversations" className="conversation-list">
      {conversations.length > 0 && (
        <input
          ref={searchInputRef}
          type="search"
          aria-label={SEARCH_INPUT_LABEL}
          placeholder={SEARCH_INPUT_LABEL}
          title="⌘K"
          className="conversation-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      )}

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
                  <fieldset className="conversation-delete-confirm">
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
                      onClick={() => setConfirmingDeleteId(null)}
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
