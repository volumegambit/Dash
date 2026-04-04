import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockApi } from '../../../../../vitest.setup.js';
import { useAgentsStore } from '../../stores/agents.js';
import { useChannelsStore } from '../../stores/messaging-apps.js';

const mockNavigate = vi.fn();

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (opts: Record<string, unknown>) => ({
    component: opts.component,
    useParams: () => ({ id: 'agent-1' }),
    useSearch: () => ({}),
  }),
  useNavigate: () => mockNavigate,
  Link: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));

const { AgentDetail } = await import('./$id.js');

const activeAgent = {
  id: 'agent-1',
  name: 'Developer',
  status: 'active' as const,
  registeredAt: new Date().toISOString(),
  config: {
    model: 'claude-sonnet-4-6',
    systemPrompt: '',
    tools: [],
  },
};

describe('AgentDetail', () => {
  beforeEach(() => {
    mockNavigate.mockReset();
    mockApi.agentsList.mockResolvedValue([activeAgent]);
    useAgentsStore.setState({
      agents: [activeAgent],
      loading: false,
      error: null,
    });
    useChannelsStore.setState({
      channels: [],
      loading: false,
      error: null,
    });
  });

  it('shows Chat button when agent is active', async () => {
    render(<AgentDetail />);
    expect(await screen.findByRole('button', { name: /chat/i })).toBeInTheDocument();
  });

  it('Chat button navigates to /chat with agentId', async () => {
    const user = userEvent.setup();
    render(<AgentDetail />);
    await user.click(await screen.findByRole('button', { name: /chat/i }));
    expect(mockNavigate).toHaveBeenCalledWith({
      to: '/chat',
      search: { agentId: 'agent-1' },
    });
  });

  it('does not show Chat button when agent is disabled', async () => {
    const disabledAgent = { ...activeAgent, status: 'disabled' as const };
    mockApi.agentsList.mockResolvedValue([disabledAgent]);
    useAgentsStore.setState({
      agents: [disabledAgent],
      loading: false,
      error: null,
    });
    render(<AgentDetail />);
    await screen.findByText('Developer');
    expect(screen.queryByRole('button', { name: /chat/i })).not.toBeInTheDocument();
  });
});
