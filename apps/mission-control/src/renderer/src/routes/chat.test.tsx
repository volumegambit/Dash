import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { mockApi } from '../../../../vitest.setup.js';
import { useDeploymentsStore } from '../stores/deployments.js';
import { useChatStore } from '../stores/chat.js';

// jsdom does not implement scrollIntoView
Element.prototype.scrollIntoView = vi.fn();

const mockUseSearch = vi.fn().mockReturnValue({ deploymentId: '', agentName: '' });

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (opts: Record<string, unknown>) => ({
    component: opts.component,
    useSearch: mockUseSearch,
  }),
}));

const { Chat } = await import('./chat.js');

const dep1 = {
  id: 'dep-1',
  name: 'Developer',
  status: 'running' as const,
  createdAt: new Date().toISOString(),
  managementPort: 53891,
  chatPort: 53892,
  agentServerPid: 1,
  gatewayPid: 2,
  config: { agents: { myAgent: { model: 'claude-sonnet-4-6', systemPrompt: '' } } },
};

const dep2 = {
  id: 'dep-2',
  name: 'Assistant',
  status: 'running' as const,
  createdAt: new Date().toISOString(),
  managementPort: 53893,
  chatPort: 53894,
  agentServerPid: 3,
  gatewayPid: 4,
  config: { agents: { helper: { model: 'claude-sonnet-4-6', systemPrompt: '' } } },
};

describe('Chat search params', () => {
  beforeEach(() => {
    mockUseSearch.mockReset();
    mockUseSearch.mockReturnValue({ deploymentId: '', agentName: '' });
    useChatStore.setState({
      conversations: [],
      selectedConversationId: null,
      messages: {},
      streamingEvents: {},
      sending: {},
    });
    mockApi.chatListConversations.mockResolvedValue([]);
  });

  it('loads conversations for the deployment passed via search params, not the auto-selected one', async () => {
    // dep-2 is first (auto-select would pick it), but search param says dep-1
    useDeploymentsStore.setState({
      deployments: [dep2, dep1],
      loading: false,
      error: null,
      logLines: {},
    });
    mockApi.deploymentsList.mockResolvedValue([dep2, dep1]);
    mockUseSearch.mockReturnValue({ deploymentId: 'dep-1', agentName: 'myAgent' });
    render(<Chat />);
    await screen.findByText('Chat');
    expect(mockApi.chatListConversations).toHaveBeenCalledWith('dep-1');
    expect(mockApi.chatListConversations).not.toHaveBeenCalledWith('dep-2');
  });

  it('falls back to auto-selecting first running deployment when no search params', async () => {
    useDeploymentsStore.setState({
      deployments: [dep1],
      loading: false,
      error: null,
      logLines: {},
    });
    mockApi.deploymentsList.mockResolvedValue([dep1]);
    mockUseSearch.mockReturnValue({ deploymentId: '', agentName: '' });
    render(<Chat />);
    await screen.findByText('Chat');
    expect(mockApi.chatListConversations).toHaveBeenCalledWith('dep-1');
  });
});
