import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockApi } from '../../../../../vitest.setup.js';
import type { IssueDetail } from '../../../../shared/projects-ipc.js';
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

beforeEach(() => {
  useProjectsStore.setState({ issuesById: {}, projectsById: {}, inbox: [], detailById: {} });
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
