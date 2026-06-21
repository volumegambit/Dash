import { useEffect, useRef } from 'react';
import { useAgentsStore } from '../stores/agents.js';
import { useChatStore } from '../stores/chat.js';
import { useUIStore } from '../stores/ui.js';
import { CompanionStack } from './CompanionStack.js';
import { attentionIds, newAttentionIds } from './cards.js';
import { selectCompanionSessions } from './selectCompanionSessions.js';
import { buildSnapshot } from './snapshot.js';

export function Companion(): JSX.Element | null {
  const chat = useChatStore();
  const agents = useAgentsStore();
  const { companionVisible, companionCollapsed, setCompanionCollapsed } = useUIStore();

  const sessions = selectCompanionSessions(buildSnapshot(chat, agents));

  // Auto-expand when a session newly enters needs/error/done.
  const prevAttention = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!companionVisible) return;
    const fresh = newAttentionIds(prevAttention.current, sessions);
    prevAttention.current = attentionIds(sessions);
    if (fresh.length > 0) {
      setCompanionCollapsed(false);
      const timer = setTimeout(() => setCompanionCollapsed(true), 6000);
      return () => clearTimeout(timer);
    }
    return undefined;
  });

  if (!companionVisible) return null;

  return (
    <div className="pointer-events-none fixed bottom-4 right-5 z-50 flex justify-end">
      <div className="pointer-events-auto">
        <CompanionStack
          sessions={sessions}
          expanded={!companionCollapsed}
          now={Date.now()}
          onToggle={() => setCompanionCollapsed(!companionCollapsed)}
          onOpen={(id) => {
            void chat.selectConversation(id);
            setCompanionCollapsed(true);
          }}
        />
      </div>
    </div>
  );
}
