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

// jsdom does not implement scrollIntoView (SessionPanel auto-follows).
Element.prototype.scrollIntoView = vi.fn();

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

const mcConversation = {
  id: 'conv-42',
  agentId: 'agent-reg',
  title: 'TASK-1 — Doomed task',
  createdAt: '2026-06-01T00:00:00Z',
  updatedAt: '2026-06-01T00:00:00Z',
};

beforeEach(() => {
  useProjectsStore.setState({ issuesById: {}, projectsById: {}, inbox: [], detailById: {} });
  useAgentsStore.setState({ agents: [], loading: false, error: null });
  useChatStore.setState({ conversations: [], messages: {}, sending: {}, streamingEvents: {} });
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

  it('shows the latest MC-linked session in the panel automatically', async () => {
    const d = detail({ linked_sessions: [sessionLink()] });
    useProjectsStore.setState({ detailById: { issue_1: d } });
    mockApi.projectsGetIssue.mockResolvedValue(d);
    mockApi.chatListConversations.mockResolvedValue([mcConversation]);
    mockApi.chatGetMessages.mockResolvedValue([
      {
        id: 'm1',
        role: 'assistant',
        content: { type: 'assistant', events: [{ type: 'text_delta', text: 'I loaded TASK-1' }] },
        timestamp: '2026-06-01T00:00:01Z',
      },
    ]);
    render(<TaskDetail />);

    // Transcript renders in-window without any chip interaction.
    expect(await screen.findByText(/I loaded TASK-1/)).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Reply to the agent…')).toBeInTheDocument();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('chip selects the session in the panel; the external-link icon opens Chat', async () => {
    const older = sessionLink({
      session_id: 'conv-41',
      last_referenced_at: '2026-05-01T00:00:00Z',
    });
    const d = detail({ linked_sessions: [older, sessionLink()] });
    useProjectsStore.setState({ detailById: { issue_1: d } });
    mockApi.projectsGetIssue.mockResolvedValue(d);
    mockApi.chatListConversations.mockResolvedValue([
      mcConversation,
      { ...mcConversation, id: 'conv-41' },
    ]);
    mockApi.chatGetMessages.mockImplementation(async (id: string) => [
      {
        id: `m-${id}`,
        role: 'assistant',
        content: { type: 'assistant', events: [{ type: 'text_delta', text: `transcript ${id}` }] },
        timestamp: '2026-06-01T00:00:01Z',
      },
    ]);
    render(<TaskDetail />);

    // Latest session (conv-42) shows by default; picking the older chip swaps the panel.
    expect(await screen.findByText(/transcript conv-42/)).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('session-chip-conv-41'));
    expect(await screen.findByText(/transcript conv-41/)).toBeInTheDocument();
    expect(mockNavigate).not.toHaveBeenCalled();

    await userEvent.click(screen.getByTestId('session-open-chat'));
    expect(mockNavigate).toHaveBeenCalledWith({
      to: '/chat',
      search: { agentId: '', conversationId: 'conv-41' },
    });
  });

  it('hides comment_* noise rows from the timeline and stamps rows with relative time', async () => {
    const d = detail({
      events: [
        {
          id: 'e1',
          issue_id: 'issue_1',
          type: 'comment_added',
          actor_type: 'agent',
          actor_id: 'Developer',
          data: '{}',
          created_at: '2026-06-01T00:00:02Z',
        },
        {
          id: 'e2',
          issue_id: 'issue_1',
          type: 'status_change',
          actor_type: 'human',
          actor_id: 'local',
          data: '{"from":"todo","to":"in_progress"}',
          created_at: '2026-06-01T00:00:03Z',
        },
      ],
    });
    useProjectsStore.setState({ detailById: { issue_1: d } });
    mockApi.projectsGetIssue.mockResolvedValue(d);
    render(<TaskDetail />);

    expect(await screen.findByText(/Status: todo → in_progress/)).toBeInTheDocument();
    expect(screen.queryByText('comment_added')).not.toBeInTheDocument();
  });

  it('labels a session_linked event with the agent name from the link', async () => {
    const d = detail({
      linked_sessions: [sessionLink()],
      events: [
        {
          id: 'e1',
          issue_id: 'issue_1',
          type: 'session_linked',
          actor_type: 'agent',
          actor_id: 'Developer',
          data: '{"session_id":"conv-42"}',
          created_at: '2026-06-01T00:00:02Z',
        },
      ],
    });
    useProjectsStore.setState({ detailById: { issue_1: d } });
    mockApi.projectsGetIssue.mockResolvedValue(d);
    render(<TaskDetail />);

    expect(await screen.findByText(/🤖 Developer session linked/)).toBeInTheDocument();
    expect(screen.queryByText(/Linked session conv-42/)).not.toBeInTheDocument();
  });

  it('shows a DESCRIPTION section with a placeholder when empty', async () => {
    const d = detail();
    useProjectsStore.setState({ detailById: { issue_1: d } });
    mockApi.projectsGetIssue.mockResolvedValue(d);
    render(<TaskDetail />);

    expect(await screen.findByText('Description')).toBeInTheDocument();
    expect(screen.getByText('No description')).toBeInTheDocument();
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
