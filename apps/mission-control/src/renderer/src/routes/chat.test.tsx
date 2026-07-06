import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { mockApi } from '../../../../vitest.setup.js';
import type { McAgentEvent } from '../../../shared/ipc.js';
import { useAgentsStore } from '../stores/agents.js';
import { useChatStore } from '../stores/chat.js';

// jsdom does not implement scrollIntoView
Element.prototype.scrollIntoView = vi.fn();

const mockUseSearch = vi.fn().mockReturnValue({ agentId: '' });

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (opts: Record<string, unknown>) => ({
    component: opts.component,
    useSearch: mockUseSearch,
  }),
  useNavigate: () => vi.fn(),
}));

const { Chat, MessageBubble } = await import('./chat.js');

const agent1 = {
  id: 'agent-1',
  name: 'Developer',
  status: 'active' as const,
  registeredAt: new Date().toISOString(),
  config: { model: 'claude-sonnet-4-6', systemPrompt: '' },
};

const agent2 = {
  id: 'agent-2',
  name: 'Assistant',
  status: 'active' as const,
  registeredAt: new Date().toISOString(),
  config: { model: 'claude-sonnet-4-6', systemPrompt: '' },
};

describe('Chat search params', () => {
  beforeEach(() => {
    mockUseSearch.mockReset();
    mockUseSearch.mockReturnValue({ agentId: '' });
    useChatStore.setState({
      conversations: [],
      selectedConversationId: null,
      messages: {},
      streamingEvents: {},
      sending: {},
    });
    mockApi.chatListConversations.mockResolvedValue([]);
  });

  it('creates a conversation for the agent passed via search params', async () => {
    useAgentsStore.setState({
      agents: [agent2, agent1],
      loading: false,
      error: null,
    });
    mockUseSearch.mockReturnValue({ agentId: 'agent-1' });
    render(<Chat />);
    await vi.waitFor(() => {
      expect(mockApi.chatCreateConversation).toHaveBeenCalledWith('agent-1');
    });
  });

  it('selects an existing conversation passed via search params', async () => {
    useAgentsStore.setState({ agents: [agent1], loading: false, error: null });
    mockUseSearch.mockReturnValue({ agentId: '', conversationId: 'conv-42' });
    mockApi.chatGetMessages.mockResolvedValue([]);
    render(<Chat />);
    await vi.waitFor(() => {
      expect(useChatStore.getState().selectedConversationId).toBe('conv-42');
    });
    // Deep-linking to a conversation must not spawn a new one.
    expect(mockApi.chatCreateConversation).not.toHaveBeenCalled();
  });
});

describe('MessageBubble unresolved tool calls', () => {
  const toolStart = {
    type: 'tool_use_start',
    id: 't1',
    name: 'wait_workers',
    input: {},
  } satisfies McAgentEvent;

  function assistantMessage(events: Record<string, unknown>[]) {
    return {
      id: 'm1',
      role: 'assistant' as const,
      content: { type: 'assistant' as const, events },
      timestamp: '2026-07-06T00:00:00Z',
    };
  }

  it('shows a spinner for an unresolved tool call while streaming', () => {
    const { container } = render(
      <MessageBubble message={assistantMessage([])} streamingEvents={[toolStart]} />,
    );
    expect(container.querySelector('.animate-spin')).not.toBeNull();
    expect(container.textContent).not.toContain('interrupted');
  });

  it('renders an unresolved tool call as interrupted (no spinner) from history', () => {
    const { container } = render(<MessageBubble message={assistantMessage([toolStart])} />);
    expect(container.querySelector('.animate-spin')).toBeNull();
    expect(container.textContent).toContain('interrupted');
    expect(container.querySelector('.lucide-ban')).not.toBeNull();
  });
});

describe('MessageBubble auto-retry rendering', () => {
  function assistantMessage(events: Record<string, unknown>[]) {
    return {
      id: 'm1',
      role: 'assistant' as const,
      content: { type: 'assistant' as const, events },
      timestamp: '2026-07-06T00:00:00Z',
    };
  }

  const transientError = {
    type: 'error',
    error: 'Request timed out.',
    timestamp: '2026-07-06T00:00:01Z',
  } satisfies McAgentEvent;

  const retry = {
    type: 'agent_retry',
    attempt: 1,
    reason: 'Request timed out.',
  } satisfies McAgentEvent;

  it('folds a transient error into a retry notice when agent_retry follows', () => {
    const { container } = render(
      <MessageBubble message={assistantMessage([])} streamingEvents={[transientError, retry]} />,
    );
    expect(container.textContent).toContain('Retrying (attempt 1)');
    // The superseded error must not render as a terminal red error block
    expect(container.querySelector('.text-red')).toBeNull();
  });

  it('still renders a terminal error red when no retry follows', () => {
    const { container } = render(
      <MessageBubble message={assistantMessage([])} streamingEvents={[transientError]} />,
    );
    expect(container.querySelector('.text-red')).not.toBeNull();
    expect(container.textContent).toContain('Request timed out.');
    expect(container.textContent).not.toContain('Retrying');
  });

  it('renders retry notice followed by recovered content', () => {
    const { container } = render(
      <MessageBubble
        message={assistantMessage([])}
        streamingEvents={[transientError, retry, { type: 'text_delta', text: 'Recovered fine.' }]}
      />,
    );
    expect(container.textContent).toContain('Retrying (attempt 1)');
    expect(container.textContent).toContain('Recovered fine.');
    expect(container.querySelector('.text-red')).toBeNull();
  });
});
