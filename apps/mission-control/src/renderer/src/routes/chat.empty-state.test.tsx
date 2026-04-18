import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EmptyChatState,
  type EmptyStateAgent,
  type RecentConversationItem,
  relativeTime,
} from './chat.empty-state.js';

const FIXED_NOW = new Date('2026-04-14T12:00:00.000Z').getTime();

const agents: EmptyStateAgent[] = [
  { id: 'agent-1', name: 'Developer', model: 'claude-sonnet-4-6' },
  { id: 'agent-2', name: 'Researcher', model: 'claude-opus-4-6' },
  { id: 'agent-3', name: 'Writer', model: 'gpt-4o' },
];

const recents: RecentConversationItem[] = [
  {
    id: 'conv-1',
    title: 'Debugging auth flow',
    agentName: 'Developer',
    updatedAt: '2026-04-14T10:00:00.000Z',
  },
  {
    id: 'conv-2',
    title: 'Draft announcement',
    agentName: 'Writer',
    updatedAt: '2026-04-13T12:00:00.000Z',
  },
  {
    id: 'conv-3',
    title: '',
    agentName: 'Researcher',
    updatedAt: '2026-04-11T12:00:00.000Z',
  },
];

describe('relativeTime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns seconds under a minute', () => {
    expect(relativeTime(new Date(FIXED_NOW - 30_000).toISOString())).toBe('30s ago');
  });

  it('returns minutes under an hour', () => {
    expect(relativeTime(new Date(FIXED_NOW - 5 * 60_000).toISOString())).toBe('5 min ago');
  });

  it('returns hours under a day', () => {
    expect(relativeTime(new Date(FIXED_NOW - 3 * 3_600_000).toISOString())).toBe('3h ago');
  });

  it('returns days for anything older', () => {
    expect(relativeTime(new Date(FIXED_NOW - 2 * 86_400_000).toISOString())).toBe('2d ago');
  });
});

describe('EmptyChatState', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // ---- sub-state: both ------------------------------------------------------

  describe('both recents and agents present', () => {
    it('renders the "both" variant with Recent and Start with sections', () => {
      render(
        <EmptyChatState
          recentConversations={recents}
          agents={agents}
          onSelectConversation={vi.fn()}
          onStartWithAgent={vi.fn()}
          onNavigateToAgents={vi.fn()}
        />,
      );
      const root = screen.getByTestId('empty-chat-state');
      expect(root).toHaveAttribute('data-variant', 'both');
      expect(root.textContent).toContain('Recent');
      expect(root.textContent).toContain('Start with');
    });

    it('renders every recent conversation with its agent name and relative time', () => {
      render(
        <EmptyChatState
          recentConversations={recents}
          agents={agents}
          onSelectConversation={vi.fn()}
          onStartWithAgent={vi.fn()}
          onNavigateToAgents={vi.fn()}
        />,
      );
      expect(screen.getByText('Debugging auth flow')).toBeInTheDocument();
      expect(screen.getByText('Draft announcement')).toBeInTheDocument();
      // All three recents render a row
      expect(screen.getByTestId('empty-chat-recent-conv-1')).toBeInTheDocument();
      expect(screen.getByTestId('empty-chat-recent-conv-2')).toBeInTheDocument();
      expect(screen.getByTestId('empty-chat-recent-conv-3')).toBeInTheDocument();
    });

    it('falls back to "Untitled" when a recent conversation has an empty title', () => {
      render(
        <EmptyChatState
          recentConversations={recents}
          agents={agents}
          onSelectConversation={vi.fn()}
          onStartWithAgent={vi.fn()}
          onNavigateToAgents={vi.fn()}
        />,
      );
      const row = screen.getByTestId('empty-chat-recent-conv-3');
      expect(row.textContent).toContain('Untitled');
    });

    it('clicking a recent conversation fires onSelectConversation with its id', () => {
      const onSelectConversation = vi.fn();
      render(
        <EmptyChatState
          recentConversations={recents}
          agents={agents}
          onSelectConversation={onSelectConversation}
          onStartWithAgent={vi.fn()}
          onNavigateToAgents={vi.fn()}
        />,
      );
      fireEvent.click(screen.getByTestId('empty-chat-recent-conv-2'));
      expect(onSelectConversation).toHaveBeenCalledWith('conv-2');
    });

    it('renders every agent with its model subtitle', () => {
      render(
        <EmptyChatState
          recentConversations={recents}
          agents={agents}
          onSelectConversation={vi.fn()}
          onStartWithAgent={vi.fn()}
          onNavigateToAgents={vi.fn()}
        />,
      );
      expect(screen.getByTestId('empty-chat-agent-agent-1').textContent).toContain('Developer');
      expect(screen.getByTestId('empty-chat-agent-agent-1').textContent).toContain(
        'claude-sonnet-4-6',
      );
      expect(screen.getByTestId('empty-chat-agent-agent-2').textContent).toContain('Researcher');
      expect(screen.getByTestId('empty-chat-agent-agent-3').textContent).toContain('Writer');
    });

    it('clicking an agent fires onStartWithAgent with its id', () => {
      const onStartWithAgent = vi.fn();
      render(
        <EmptyChatState
          recentConversations={recents}
          agents={agents}
          onSelectConversation={vi.fn()}
          onStartWithAgent={onStartWithAgent}
          onNavigateToAgents={vi.fn()}
        />,
      );
      fireEvent.click(screen.getByTestId('empty-chat-agent-agent-2'));
      expect(onStartWithAgent).toHaveBeenCalledWith('agent-2');
    });

    it('shows the ⌘T shortcut hint', () => {
      render(
        <EmptyChatState
          recentConversations={recents}
          agents={agents}
          onSelectConversation={vi.fn()}
          onStartWithAgent={vi.fn()}
          onNavigateToAgents={vi.fn()}
        />,
      );
      expect(screen.getByText(/⌘T/)).toBeInTheDocument();
    });
  });

  // ---- sub-state: no recents ------------------------------------------------

  describe('agents exist but no recent conversations', () => {
    it('renders the "no-recents" variant with just the agent list', () => {
      render(
        <EmptyChatState
          recentConversations={[]}
          agents={agents}
          onSelectConversation={vi.fn()}
          onStartWithAgent={vi.fn()}
          onNavigateToAgents={vi.fn()}
        />,
      );
      const root = screen.getByTestId('empty-chat-state');
      expect(root).toHaveAttribute('data-variant', 'no-recents');
      expect(root.textContent).toContain('Start a conversation with');
      expect(screen.queryByText('Recent')).toBeNull();
    });

    it('agent clicks still work in the no-recents variant', () => {
      const onStartWithAgent = vi.fn();
      render(
        <EmptyChatState
          recentConversations={[]}
          agents={agents}
          onSelectConversation={vi.fn()}
          onStartWithAgent={onStartWithAgent}
          onNavigateToAgents={vi.fn()}
        />,
      );
      fireEvent.click(screen.getByTestId('empty-chat-agent-agent-1'));
      expect(onStartWithAgent).toHaveBeenCalledWith('agent-1');
    });
  });

  // ---- sub-state: no agents -------------------------------------------------

  describe('no agents at all', () => {
    it('renders the "no-agents" variant with a deploy CTA', () => {
      render(
        <EmptyChatState
          recentConversations={[]}
          agents={[]}
          onSelectConversation={vi.fn()}
          onStartWithAgent={vi.fn()}
          onNavigateToAgents={vi.fn()}
        />,
      );
      const root = screen.getByTestId('empty-chat-state');
      expect(root).toHaveAttribute('data-variant', 'no-agents');
      expect(root.textContent).toContain("You don't have any agents yet");
      expect(screen.getByRole('button', { name: /Deploy an agent/i })).toBeInTheDocument();
    });

    it('the deploy CTA fires onNavigateToAgents', () => {
      const onNavigateToAgents = vi.fn();
      render(
        <EmptyChatState
          recentConversations={[]}
          agents={[]}
          onSelectConversation={vi.fn()}
          onStartWithAgent={vi.fn()}
          onNavigateToAgents={onNavigateToAgents}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: /Deploy an agent/i }));
      expect(onNavigateToAgents).toHaveBeenCalled();
    });

    it('takes precedence even when there ARE recent conversations (orphaned recents fall through)', () => {
      // Edge case: agent got deleted but its old conversations are still in the
      // store. Without agents the user cannot start anything new *or* chat in
      // the orphaned conversations — the deploy CTA is the only useful action.
      render(
        <EmptyChatState
          recentConversations={recents}
          agents={[]}
          onSelectConversation={vi.fn()}
          onStartWithAgent={vi.fn()}
          onNavigateToAgents={vi.fn()}
        />,
      );
      expect(screen.getByTestId('empty-chat-state')).toHaveAttribute('data-variant', 'no-agents');
    });
  });
});
