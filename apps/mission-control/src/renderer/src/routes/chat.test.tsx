import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { mockApi } from '../../../../vitest.setup.js';
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

const { Chat } = await import('./chat.js');

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
});
