import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockApi } from '../../../../../vitest.setup.js';
import { useDeploymentsStore } from '../../stores/deployments.js';
import { useMessagingAppsStore } from '../../stores/messaging-apps.js';

const mockNavigate = vi.fn();

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (opts: Record<string, unknown>) => ({
    component: opts.component,
    useParams: () => ({ id: 'dep-1' }),
  }),
  useNavigate: () => mockNavigate,
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));

const { AgentDetail } = await import('./$id.js');

const runningDeployment = {
  id: 'dep-1',
  name: 'Developer',
  status: 'running' as const,
  createdAt: new Date().toISOString(),
  managementPort: 53891,
  chatPort: 53892,
  agentServerPid: 1,
  gatewayPid: 2,
  config: {
    agents: { myAgent: { model: 'claude-sonnet-4-6', systemPrompt: '' } },
  },
};

describe('AgentDetail', () => {
  beforeEach(() => {
    mockNavigate.mockReset();
    mockApi.deploymentsList.mockResolvedValue([runningDeployment]);
    useDeploymentsStore.setState({
      deployments: [runningDeployment],
      loading: false,
      error: null,
      logLines: {},
    });
  });

  it('shows Chat button when agent is running', async () => {
    render(<AgentDetail />);
    expect(await screen.findByRole('button', { name: /chat/i })).toBeInTheDocument();
  });

  it('Chat button navigates to /chat with deploymentId and agentName', async () => {
    const user = userEvent.setup();
    render(<AgentDetail />);
    await user.click(await screen.findByRole('button', { name: /chat/i }));
    expect(mockNavigate).toHaveBeenCalledWith({
      to: '/chat',
      search: { deploymentId: 'dep-1', agentName: 'myAgent' },
    });
  });

  it('does not show Chat button when agent is stopped', async () => {
    const stoppedDeployment = { ...runningDeployment, status: 'stopped' as const };
    mockApi.deploymentsList.mockResolvedValue([stoppedDeployment]);
    useDeploymentsStore.setState({
      deployments: [stoppedDeployment],
      loading: false,
      error: null,
      logLines: {},
    });
    render(<AgentDetail />);
    await screen.findByText('Developer');
    expect(screen.queryByRole('button', { name: /chat/i })).not.toBeInTheDocument();
  });

  it('shows connect messaging app banner when agent is running and no apps are connected', async () => {
    render(<AgentDetail />);
    expect(await screen.findByText(/connect to a messaging app/i)).toBeInTheDocument();
  });

  it('hides banner when a messaging app routes to this agent', async () => {
    mockApi.messagingAppsList.mockResolvedValue([
      {
        id: 'app-1',
        name: 'My Telegram',
        type: 'telegram',
        enabled: true,
        routing: [
          {
            id: 'rule-1',
            condition: 'default',
            targetAgentName: 'myAgent',
            allowList: [],
            denyList: [],
          },
        ],
        globalDenyList: [],
        createdAt: new Date().toISOString(),
      },
    ]);
    useMessagingAppsStore.setState({ apps: [] });
    render(<AgentDetail />);
    await screen.findByText('Developer');
    await waitFor(() => {
      expect(screen.queryByText(/connect to a messaging app/i)).not.toBeInTheDocument();
    });
  });

  it('hides banner when dismissed', async () => {
    const user = userEvent.setup();
    render(<AgentDetail />);
    const dismissBtn = await screen.findByRole('button', { name: /dismiss/i });
    await user.click(dismissBtn);
    expect(screen.queryByText(/connect to a messaging app/i)).not.toBeInTheDocument();
  });
});
