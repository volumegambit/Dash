import type { MobileAgent } from '@dash/mobile-contract';
import { useEffect, useState } from 'react';
import { useWebAppStore } from './Shell.js';

export interface ConversationListProps {
  selectedConversationId: string | null;
  onSelect: (conversationId: string) => void;
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

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : 'Failed to start a new conversation.';
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
 */
export function ConversationList({ selectedConversationId, onSelect }: ConversationListProps) {
  const useAppStore = useWebAppStore();
  const conversations = useAppStore((s) => s.conversations);
  const connection = useAppStore((s) => s.connection);
  const loadConversations = useAppStore((s) => s.loadConversations);
  const listAgents = useAppStore((s) => s.listAgents);
  const startConversation = useAppStore((s) => s.startConversation);

  const [agentChoices, setAgentChoices] = useState<MobileAgent[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void loadConversations();
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

  // C4: when the connection is unreachable ('offline') or the credential was
  // rejected ('unauthorized'), ChatView's banner already owns the screen —
  // showing "No conversations yet." alongside it would misdescribe a
  // transport/credential problem as an empty account.
  const suppressEmptyCopy = connection === 'offline' || connection === 'unauthorized';

  return (
    <nav aria-label="Conversations" style={{ borderRight: '1px solid #ddd', minWidth: 220 }}>
      <button
        type="button"
        data-testid={NEW_CONVERSATION_TESTID}
        onClick={() => void handleNewConversation()}
        disabled={busy}
        style={{ display: 'block', width: '100%', padding: '8px', cursor: 'pointer' }}
      >
        {NEW_CONVERSATION_LABEL}
      </button>

      {agentChoices && agentChoices.length > 1 && (
        <ul aria-label="Choose an agent" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {agentChoices.map((agent) => (
            <li key={agent.id}>
              <button
                type="button"
                onClick={() => void createWithAgent(agent.id)}
                disabled={busy}
                style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px' }}
              >
                {agent.name}
              </button>
            </li>
          ))}
        </ul>
      )}

      {error && <p role="alert">{error}</p>}

      {conversations.length === 0 ? (
        suppressEmptyCopy ? null : (
          <p style={{ padding: '0 8px', color: '#888' }}>{NO_CONVERSATIONS_COPY}</p>
        )
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {conversations.map((conversation) => {
            const isSelected = conversation.id === selectedConversationId;
            return (
              <li key={conversation.id}>
                <button
                  type="button"
                  aria-current={isSelected ? 'true' : undefined}
                  onClick={() => onSelect(conversation.id)}
                  style={{
                    display: 'block',
                    width: '100%',
                    textAlign: 'left',
                    padding: '8px',
                    border: 'none',
                    background: isSelected ? '#eef' : 'transparent',
                    cursor: 'pointer',
                  }}
                >
                  <div style={{ fontWeight: isSelected ? 600 : 400 }}>
                    {conversation.title || conversation.agentName}
                  </div>
                  {conversation.lastMessagePreview && (
                    <div style={{ fontSize: '0.8em', color: '#888' }}>
                      {conversation.lastMessagePreview}
                    </div>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </nav>
  );
}

export default ConversationList;
