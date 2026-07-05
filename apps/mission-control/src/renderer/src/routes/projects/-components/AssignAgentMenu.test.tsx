import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockApi } from '../../../../../../vitest.setup.js';
import type { Issue } from '../../../../../shared/projects-ipc.js';
import { useAgentsStore } from '../../../stores/agents.js';
import { useProjectsStore } from '../../../stores/projects.js';
import { AssignAgentMenu } from './AssignAgentMenu.js';
import { IssueRow } from './IssueRow.js';
import { KanbanCard } from './KanbanCard.js';

const devAgent = {
  id: 'agent-reg',
  name: 'Developer',
  status: 'active' as const,
  registeredAt: '2026-06-01T00:00:00Z',
  config: { model: 'claude-sonnet-5', systemPrompt: '' },
};

function issue(patch: Partial<Issue> = {}): Issue {
  return {
    id: 'issue_1',
    key: 'TASK-1',
    project_id: null,
    parent_issue_id: null,
    title: 'A task',
    description: '',
    status: 'todo',
    sub_status: null,
    assignee_user_id: 'local',
    created_by: 'human',
    created_by_agent_id: null,
    created_at: '2026-06-01T00:00:00Z',
    updated_at: '2026-06-01T00:00:00Z',
    completed_at: null,
    ...patch,
  };
}

beforeEach(() => {
  useAgentsStore.setState({ agents: [devAgent], loading: false, error: null });
  useProjectsStore.setState({ issuesById: {}, projectsById: {}, inbox: [], detailById: {} });
});

describe('AssignAgentMenu', () => {
  it('opens on click, lists non-disabled agents, and dispatches the picked one', async () => {
    useAgentsStore.setState({
      agents: [devAgent, { ...devAgent, id: 'agent-off', name: 'Retired', status: 'disabled' }],
    });
    render(<AssignAgentMenu issueId="issue_1" />);

    await userEvent.click(screen.getByTestId('assign-menu-issue_1'));
    expect(screen.getByText('Developer')).toBeInTheDocument();
    expect(screen.queryByText('Retired')).not.toBeInTheDocument();

    await userEvent.click(screen.getByText('Developer'));
    await waitFor(() =>
      expect(mockApi.projectsAssignAgent).toHaveBeenCalledWith('issue_1', 'agent-reg', 'Developer'),
    );
    // Menu closes after a successful dispatch.
    expect(screen.queryByText('Developer')).not.toBeInTheDocument();
  });

  it('lazily loads agents when the store is empty', async () => {
    useAgentsStore.setState({ agents: [] });
    mockApi.agentsList.mockResolvedValue([devAgent]);
    render(<AssignAgentMenu issueId="issue_1" />);

    await userEvent.click(screen.getByTestId('assign-menu-issue_1'));
    expect(await screen.findByText('Developer')).toBeInTheDocument();
  });
});

describe('assign affordance embedding', () => {
  it('KanbanCard: assign click does not open the card', async () => {
    const onOpen = vi.fn();
    render(<KanbanCard issue={issue()} onOpen={onOpen} />);

    await userEvent.click(screen.getByTestId('assign-menu-issue_1'));
    await userEvent.click(screen.getByText('Developer'));

    await waitFor(() => expect(mockApi.projectsAssignAgent).toHaveBeenCalled());
    expect(onOpen).not.toHaveBeenCalled();
    // The card itself still opens on a normal click.
    await userEvent.click(screen.getByText('A task'));
    expect(onOpen).toHaveBeenCalledWith('issue_1');
  });

  it('IssueRow: assign click does not open the row', async () => {
    const onOpen = vi.fn();
    render(
      <table>
        <tbody>
          <IssueRow issue={issue()} onOpen={onOpen} />
        </tbody>
      </table>,
    );

    await userEvent.click(screen.getByTestId('assign-menu-issue_1'));
    await userEvent.click(screen.getByText('Developer'));

    await waitFor(() => expect(mockApi.projectsAssignAgent).toHaveBeenCalled());
    expect(onOpen).not.toHaveBeenCalled();
    await userEvent.click(screen.getByText('A task'));
    expect(onOpen).toHaveBeenCalledWith('issue_1');
  });
});
