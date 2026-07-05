import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockApi } from '../../../../../vitest.setup.js';
import type { IssueDetail, SessionIssueLink } from '../../../../shared/projects-ipc.js';
import { useAgentsStore } from '../../stores/agents.js';
import { useChatStore } from '../../stores/chat.js';
import { useProjectsStore } from '../../stores/projects.js';

const mockNavigate = vi.fn();
const mockUseParams = vi.fn().mockReturnValue({ issueId: 'issue_1' });

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (opts: Record<string, unknown>) => ({
    component: opts.component,
    useParams: mockUseParams,
  }),
  useNavigate: () => mockNavigate,
}));

const { TaskDetail } = await import('./issues.$issueId.js');

function detail(patch: Partial<IssueDetail> = {}): IssueDetail {
  return {
    id: 'issue_1',
    key: 'TASK-1',
    project_id: null,
    parent_issue_id: null,
    title: 'Doomed task',
    description: '',
    status: 'todo',
    sub_status: null,
    assignee_user_id: 'local',
    created_by: 'human',
    created_by_agent_id: null,
    created_at: '2026-06-01T00:00:00Z',
    updated_at: '2026-06-01T00:00:00Z',
    completed_at: null,
    comments: [],
    events: [],
    linked_sessions: [],
    subtasks: [],
    ...patch,
  };
}

const devAgent = {
  id: 'agent-reg',
  name: 'Developer',
  status: 'active' as const,
  registeredAt: '2026-06-01T00:00:00Z',
  config: { model: 'claude-sonnet-5', systemPrompt: '' },
};

function sessionLink(patch: Partial<SessionIssueLink> = {}): SessionIssueLink {
  return {
    session_id: 'conv-42',
    issue_id: 'issue_1',
    agent_id: 'Developer',
    first_referenced_at: '2026-06-01T00:00:00Z',
    last_referenced_at: '2026-06-01T00:00:00Z',
    reference_count: 1,
    ...patch,
  };
}

beforeEach(() => {
  useProjectsStore.setState({ issuesById: {}, projectsById: {}, inbox: [], detailById: {} });
  useAgentsStore.setState({ agents: [], loading: false, error: null });
  useChatStore.setState({ conversations: [] });
  mockNavigate.mockClear();
});

describe('TaskDetail delete', () => {
  it('deletes after inline confirm and navigates back to the task list', async () => {
    const d = detail();
    useProjectsStore.setState({ detailById: { issue_1: d } });
    mockApi.projectsGetIssue.mockResolvedValue(d);
    render(<TaskDetail />);

    await userEvent.click(await screen.findByTestId('task-delete'));
    // Inline two-step confirm, no modal.
    expect(screen.getByText('Delete?')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('task-confirm-delete'));

    await waitFor(() => expect(mockApi.projectsDeleteIssue).toHaveBeenCalledWith('issue_1'));
    expect(mockNavigate).toHaveBeenCalledWith({ to: '/projects/all' });
  });

  it('No dismisses the confirm without deleting', async () => {
    const d = detail();
    useProjectsStore.setState({ detailById: { issue_1: d } });
    mockApi.projectsGetIssue.mockResolvedValue(d);
    render(<TaskDetail />);

    await userEvent.click(await screen.findByTestId('task-delete'));
    await userEvent.click(screen.getByText('No'));

    expect(screen.queryByText('Delete?')).not.toBeInTheDocument();
    expect(mockApi.projectsDeleteIssue).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('navigates to the parent when deleting a subtask', async () => {
    const d = detail({ parent_issue_id: 'issue_parent' });
    useProjectsStore.setState({ detailById: { issue_1: d } });
    mockApi.projectsGetIssue.mockResolvedValue(d);
    render(<TaskDetail />);

    await userEvent.click(await screen.findByTestId('task-delete'));
    await userEvent.click(screen.getByTestId('task-confirm-delete'));

    await waitFor(() =>
      expect(mockNavigate).toHaveBeenCalledWith({
        to: '/projects/issues/$issueId',
        params: { issueId: 'issue_parent' },
      }),
    );
  });

  it('assigns an agent from the picker and stays on the task', async () => {
    const d = detail();
    useProjectsStore.setState({ detailById: { issue_1: d } });
    mockApi.projectsGetIssue.mockResolvedValue(d);
    mockApi.agentsList.mockResolvedValue([devAgent]);
    render(<TaskDetail />);

    await userEvent.selectOptions(await screen.findByTestId('task-assign-agent'), 'agent-reg');
    await userEvent.click(screen.getByTestId('task-assign-start'));

    await waitFor(() =>
      expect(mockApi.projectsAssignAgent).toHaveBeenCalledWith('issue_1', 'agent-reg', 'Developer'),
    );
    // Stays on the task page — the session chip appears via the WS refetch.
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('hides disabled agents from the assign picker', async () => {
    const d = detail();
    useProjectsStore.setState({ detailById: { issue_1: d } });
    mockApi.projectsGetIssue.mockResolvedValue(d);
    mockApi.agentsList.mockResolvedValue([
      devAgent,
      { ...devAgent, id: 'agent-off', name: 'Retired', status: 'disabled' as const },
    ]);
    render(<TaskDetail />);

    const select = await screen.findByTestId('task-assign-agent');
    const options = Array.from(select.querySelectorAll('option')).map((o) => o.textContent);
    expect(options).toContain('Developer');
    expect(options).not.toContain('Retired');
  });

  it('linked-session chip opens the chat conversation when it exists in MC', async () => {
    const d = detail({ linked_sessions: [sessionLink()] });
    useProjectsStore.setState({ detailById: { issue_1: d } });
    mockApi.projectsGetIssue.mockResolvedValue(d);
    mockApi.chatListConversations.mockResolvedValue([
      {
        id: 'conv-42',
        agentId: 'agent-reg',
        title: 'TASK-1 — Doomed task',
        createdAt: '2026-06-01T00:00:00Z',
        updatedAt: '2026-06-01T00:00:00Z',
      },
    ]);
    render(<TaskDetail />);

    await userEvent.click(await screen.findByTestId('session-chip-conv-42'));

    expect(mockNavigate).toHaveBeenCalledWith({
      to: '/chat',
      search: { agentId: '', conversationId: 'conv-42' },
    });
  });

  it('keeps sessions from other channels as non-clickable chips', async () => {
    const d = detail({ linked_sessions: [sessionLink({ session_id: 'tg-session' })] });
    useProjectsStore.setState({ detailById: { issue_1: d } });
    mockApi.projectsGetIssue.mockResolvedValue(d);
    mockApi.chatListConversations.mockResolvedValue([]);
    render(<TaskDetail />);

    expect(await screen.findByText(/tg-session/)).toBeInTheDocument();
    expect(screen.queryByTestId('session-chip-tg-session')).not.toBeInTheDocument();
  });

  it('stays on the page when the delete fails', async () => {
    const d = detail();
    useProjectsStore.setState({ detailById: { issue_1: d } });
    mockApi.projectsGetIssue.mockResolvedValue(d);
    mockApi.projectsDeleteIssue.mockRejectedValue(new Error('gateway down'));
    render(<TaskDetail />);

    await userEvent.click(await screen.findByTestId('task-delete'));
    await userEvent.click(screen.getByTestId('task-confirm-delete'));

    await waitFor(() => expect(mockApi.projectsDeleteIssue).toHaveBeenCalled());
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(screen.getByText('Doomed task')).toBeInTheDocument();
  });
});
