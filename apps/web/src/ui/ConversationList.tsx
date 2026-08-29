import { useEffect } from 'react';
import { useWebAppStore } from './Shell.js';

export interface ConversationListProps {
  selectedConversationId: string | null;
  onSelect: (conversationId: string) => void;
}

/** Exact copy shown when the store's `conversations` list is empty. */
export const NO_CONVERSATIONS_COPY = 'No conversations yet.';

/**
 * Sidebar list of the account's conversations, sourced from
 * `useWebAppStore()` (the Task 11 store Shell creates per gateway). Triggers
 * `loadConversations()` once on mount — the store itself never fetches
 * eagerly — and lets the parent (`Shell`'s chat workspace) own which
 * conversation is "selected" so it can also drive `ChatView`.
 */
export function ConversationList({ selectedConversationId, onSelect }: ConversationListProps) {
  const useAppStore = useWebAppStore();
  const conversations = useAppStore((s) => s.conversations);
  const loadConversations = useAppStore((s) => s.loadConversations);

  useEffect(() => {
    void loadConversations();
  }, [loadConversations]);

  return (
    <nav aria-label="Conversations" style={{ borderRight: '1px solid #ddd', minWidth: 220 }}>
      {conversations.length === 0 ? (
        <p style={{ padding: '0 8px', color: '#888' }}>{NO_CONVERSATIONS_COPY}</p>
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
