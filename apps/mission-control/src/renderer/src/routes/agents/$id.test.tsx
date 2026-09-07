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

  // CONTRACT: the Tasks deep-link filters on the agent's config.name (here
  // 'Developer'), NOT its registry id ('agent-1'). The gateway keys
  // created_by_agent_id and session_issue_link.agent_id on config.name, so
  // passing the id would silently match zero issues.
  it('fetches the task count by config.name (not registry id)', async () => {
    mockApi.projectsListIssues.mockResolvedValue([{}, {}, {}]);
    render(<AgentDetail />);
    await waitFor(() =>
      expect(mockApi.projectsListIssues).toHaveBeenCalledWith({ agents_involved: 'Developer' }),
    );
    expect(await screen.findByRole('button', { name: /tasks \(3\)/i })).toBeInTheDocument();
  });

  it('Tasks button navigates to /projects/all with agentId = config.name', async () => {
    const user = userEvent.setup();
    render(<AgentDetail />);
    await user.click(await screen.findByRole('button', { name: /tasks/i }));
    expect(mockNavigate).toHaveBeenCalledWith({
      to: '/projects/all',
      search: { agentId: 'Developer' },
    });
  });

  describe('Tools card', () => {
    function renderWithTools(tools: string[]): void {
      const agent = { ...activeAgent, config: { ...activeAgent.config, tools } };
      mockApi.agentsList.mockResolvedValue([agent]);
      useAgentsStore.setState({ agents: [agent], loading: false, error: null });
      render(<AgentDetail />);
    }

    it('renders enabled tools grouped with friendly labels', async () => {
      renderWithTools(['read', 'grep', 'bash', 'web_search']);
      // Group headers the deploy wizard uses.
      expect(await screen.findByText('Read & Search')).toBeInTheDocument();
      expect(screen.getByText('Shell')).toBeInTheDocument();
      expect(screen.getByText('Web')).toBeInTheDocument();
      // Friendly labels, not raw ids.
      expect(screen.getByText('Grep')).toBeInTheDocument();
      expect(screen.getByText('Web Search')).toBeInTheDocument();
      // A group with no enabled tools is omitted.
      expect(screen.queryByText('Modify Files')).not.toBeInTheDocument();
    });

    it('shows a plain-language description on each group', async () => {
      renderWithTools(['read']);
      expect(await screen.findByText('Browse and search the project')).toBeInTheDocument();
    });

    it('surfaces the enabled tool count in the card header', async () => {
      renderWithTools(['read', 'grep', 'bash']);
      await screen.findByText('Read & Search');
      expect(screen.getByText('3')).toBeInTheDocument();
    });

    it('collects unknown tool ids under an Other group with a humanized label', async () => {
      renderWithTools(['read', 'linear_search_issues']);
      expect(await screen.findByText('Other')).toBeInTheDocument();
      expect(screen.getByText('Linear Search Issues')).toBeInTheDocument();
    });

    it('shows an empty state when no tools are enabled', async () => {
      renderWithTools([]);
      expect(await screen.findByText('No tools enabled')).toBeInTheDocument();
    });
  });
});
