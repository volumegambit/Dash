/**
 * Empty state for the chat panel when no conversation is selected.
 *
 * Three sub-states, in priority order:
 * 1. **No agents registered** → single CTA pointing to /agents.
 * 2. **No conversations yet (but agents exist)** → single centered
 *    "Start a conversation with…" list.
 * 3. **Both exist** → two-column layout: recent conversations on the
 *    left, agents on the right. Click recent → opens it; click agent →
 *    creates a new conversation with that agent (skipping the modal).
 *
 * Pure presentational component — no store access, no router. Callers
 * hand in the data and wiring. Kept dependency-free so it can be unit
 * tested without mocking the whole chat route.
 */

import { ArrowRight, MessageSquare, Plus } from 'lucide-react';

/** Minimal shape needed to render the recent list — matches what chat.tsx already computes. */
export interface RecentConversationItem {
  id: string;
  title: string;
  agentName: string;
  updatedAt: string;
}

/** Minimal shape for the agents column. */
export interface EmptyStateAgent {
  id: string;
  name: string;
  model?: string;
}

export interface EmptyChatStateProps {
  recentConversations: RecentConversationItem[];
  agents: EmptyStateAgent[];
  onSelectConversation: (id: string) => void;
  onStartWithAgent: (agentId: string) => void;
  onNavigateToAgents: () => void;
}

/** Matches the relativeTime helper in routes/agents/index.tsx — duplicated here so this file has zero route dependencies. */
export function relativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export function EmptyChatState({
  recentConversations,
  agents,
  onSelectConversation,
  onStartWithAgent,
  onNavigateToAgents,
}: EmptyChatStateProps): JSX.Element {
  const hasAgents = agents.length > 0;
  const hasRecents = recentConversations.length > 0;

  // Sub-state 1: no agents at all → single CTA.
  if (!hasAgents) {
    return (
      <div
        data-testid="empty-chat-state"
        data-variant="no-agents"
        className="flex h-full flex-col items-center justify-center px-8"
      >
        <div className="max-w-[320px] text-center">
          <p className="mb-4 text-sm text-muted">
            You don't have any agents yet. Deploy one to start a conversation.
          </p>
          <button
            type="button"
            onClick={onNavigateToAgents}
            className="inline-flex items-center gap-2 bg-accent px-4 py-2 text-sm font-semibold text-white transition-colors hover:opacity-90"
          >
            <Plus size={14} />
            Deploy an agent
          </button>
        </div>
      </div>
    );
  }

  // Sub-state 2: agents exist but no recent conversations yet.
  if (!hasRecents) {
    return (
      <div
        data-testid="empty-chat-state"
        data-variant="no-recents"
        className="flex h-full flex-col items-center justify-center px-8"
      >
        <div className="w-full max-w-[320px]">
          <SectionHeader>Start a conversation with</SectionHeader>
          <AgentList agents={agents} onStartWithAgent={onStartWithAgent} />
          <ShortcutHint />
        </div>
      </div>
    );
  }

  // Sub-state 3: full two-column layout.
  return (
    <div
      data-testid="empty-chat-state"
      data-variant="both"
      className="flex h-full flex-col items-center justify-center px-8"
    >
      <div className="flex w-full max-w-[720px] items-start justify-center gap-12">
        <div className="w-[300px] shrink-0">
          <SectionHeader>Recent</SectionHeader>
          <RecentList
            items={recentConversations}
            onSelectConversation={onSelectConversation}
          />
        </div>
        <div className="w-[260px] shrink-0">
          <SectionHeader>Start with</SectionHeader>
          <AgentList agents={agents} onStartWithAgent={onStartWithAgent} />
        </div>
      </div>
      <ShortcutHint />
    </div>
  );
}

function SectionHeader({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div className="mb-3 font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-[2px] text-muted">
      {children}
    </div>
  );
}

function ShortcutHint(): JSX.Element {
  return (
    <div className="mt-8 text-center">
      <span className="text-xs text-muted">
        or press{' '}
        <kbd className="bg-white/5 border border-border px-1.5 py-0.5 font-[family-name:var(--font-mono)] text-[10px]">
          ⌘N
        </kbd>{' '}
        for the full agent picker
      </span>
    </div>
  );
}

function RecentList({
  items,
  onSelectConversation,
}: {
  items: RecentConversationItem[];
  onSelectConversation: (id: string) => void;
}): JSX.Element {
  return (
    <ul className="flex flex-col">
      {items.map((conv) => (
        <li key={conv.id}>
          <button
            type="button"
            data-testid={`empty-chat-recent-${conv.id}`}
            onClick={() => onSelectConversation(conv.id)}
            className="group flex w-full items-start gap-3 border-l-2 border-transparent px-3 py-2 text-left transition-colors hover:border-accent hover:bg-white/[0.02]"
          >
            <MessageSquare size={14} className="mt-0.5 shrink-0 text-muted" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm text-foreground group-hover:text-accent">
                {conv.title || 'Untitled'}
              </div>
              <div className="mt-0.5 truncate text-[11px] text-muted">
                {conv.agentName ? `${conv.agentName} · ` : ''}
                {relativeTime(conv.updatedAt)}
              </div>
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}

function AgentList({
  agents,
  onStartWithAgent,
}: {
  agents: EmptyStateAgent[];
  onStartWithAgent: (agentId: string) => void;
}): JSX.Element {
  return (
    <ul className="flex flex-col">
      {agents.map((agent) => (
        <li key={agent.id}>
          <button
            type="button"
            data-testid={`empty-chat-agent-${agent.id}`}
            onClick={() => onStartWithAgent(agent.id)}
            className="group flex w-full items-center justify-between gap-3 border-l-2 border-transparent px-3 py-2 text-left transition-colors hover:border-accent hover:bg-white/[0.02]"
          >
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm text-foreground group-hover:text-accent">
                {agent.name}
              </div>
              {agent.model && (
                <div className="mt-0.5 truncate text-[11px] text-muted">{agent.model}</div>
              )}
            </div>
            <ArrowRight
              size={14}
              className="shrink-0 text-muted opacity-0 transition-opacity group-hover:opacity-100"
            />
          </button>
        </li>
      ))}
    </ul>
  );
}
