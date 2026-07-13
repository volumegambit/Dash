import '@testing-library/jest-dom/vitest';
import type { ConversationRef, McConversationListResult, McConversationView } from '@dash/mc';
import type { ConversationMessage } from '@dash/mobile-contract';
import { act, render, screen, waitFor } from '@testing-library/react';
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

const mcConversation: McConversationView = {
  id: 'conv-42',
  agentId: 'agent-reg',
  agentName: 'Developer',
  title: 'TASK-1 — Doomed task',
  revision: 1,
  status: 'idle',
  activeTurnId: null,
  owningIssueId: 'issue_1',
  projectId: null,
  lastSeq: 0,
  lastMessagePreview: null,
  createdAt: '2026-06-01T00:00:00Z',
  updatedAt: '2026-06-01T00:00:00Z',
  origin: 'gateway',
  offline: false,
  readOnly: false,
};

function conversationResult(items: McConversationView[]): McConversationListResult {
  return {
    items,
    nextCursor: null,
    authority: 'gateway',
    gatewayOnline: true,
  };
}

function mockConversations(items: McConversationView[]): void {
  mockApi.chatListConversations.mockResolvedValue(conversationResult(items));
  mockApi.chatGetConversation.mockImplementation(
    async (ref: ConversationRef) =>
      items.find((item) => item.id === ref.id && item.origin === ref.origin) ?? null,
  );
}

function assistantMessage(id: string, conversationId: string, text: string): ConversationMessage {
  return {
    id,
    conversationId,
    turnId: `turn-${id}`,
    ordinal: 1,
    role: 'assistant',
    status: 'completed',
    content: { type: 'assistant', events: [{ type: 'text_delta', text }] },
    createdAt: '2026-06-01T00:00:01Z',
    updatedAt: '2026-06-01T00:00:01Z',
  };
}

function messagePage(items: ConversationMessage[]) {
  return { items, nextCursor: null, throughSeq: 0 };
}

beforeEach(() => {
  useProjectsStore.setState({ issuesById: {}, projectsById: {}, inbox: [], detailById: {} });
  useAgentsStore.setState({ agents: [], loading: false, error: null });
  useChatStore.setState({
    conversations: [],
    nextConversationCursor: null,
    conversationAuthority: 'gateway',
    gatewayOnline: true,
    selectedConversationRef: null,
    openTabKeys: [],
    messages: {},
    messageCursor: {},
    throughSeq: {},
    streamingFrames: {},
    lastSeq: {},
    localTurnIds: {},
    sending: {},
    unreadConversations: new Set(),
    conversationError: null,
  });
  mockConversations([]);
  mockApi.chatGetMessages.mockResolvedValue(messagePage([]));
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

  it('shows the session pane right after assign without a remount', async () => {
    // Repro for QA 27.16 §6: assign creates a NEW conversation, so the chat
    // store's mount-time conversations snapshot excludes it and the pane never
    // rendered until the task was re-opened.
    const before = detail();
    const after = detail({ linked_sessions: [sessionLink()] });
    useProjectsStore.setState({ detailById: { issue_1: before } });
    mockApi.projectsGetIssue
      .mockResolvedValueOnce(before) // mount load
      .mockResolvedValue(after); // refetch after assign
    mockApi.agentsList.mockResolvedValue([devAgent]);
    mockApi.chatListConversations
      .mockResolvedValueOnce(conversationResult([])) // mount load — conversation doesn't exist yet
      .mockResolvedValue(conversationResult([mcConversation]));
    mockApi.chatGetConversation.mockImplementation(async (ref: ConversationRef) =>
      ref.origin === 'gateway' && ref.id === mcConversation.id ? mcConversation : null,
    );
    mockApi.chatGetMessages.mockResolvedValue(messagePage([]));
    render(<TaskDetail />);

    await userEvent.selectOptions(await screen.findByTestId('task-assign-agent'), 'agent-reg');
    await userEvent.click(screen.getByTestId('task-assign-start'));

    // Auto-switches to the new session's tab in place, no navigation/remount.
    expect(await screen.findByPlaceholderText('Reply to the agent…')).toBeInTheDocument();
    expect(screen.getByTestId('tab-session-conv-42')).toHaveAttribute('aria-selected', 'true');
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('marks a streaming session tab with an activity dot', async () => {
    const d = detail({ linked_sessions: [sessionLink()] });
    useProjectsStore.setState({ detailById: { issue_1: d } });
    useChatStore.setState({ sending: { 'gateway:conv-42': true } });
    mockApi.projectsGetIssue.mockResolvedValue(d);
    mockConversations([mcConversation]);
    mockApi.chatGetMessages.mockResolvedValue(messagePage([]));
    render(<TaskDetail />);

    expect(await screen.findByTestId('tab-dot-conv-42')).toBeInTheDocument();
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

  it('lists session tabs but defaults to the Task tab', async () => {
    const d = detail({ linked_sessions: [sessionLink()] });
    useProjectsStore.setState({ detailById: { issue_1: d } });
    mockApi.projectsGetIssue.mockResolvedValue(d);
    mockConversations([mcConversation]);
    mockApi.chatGetMessages.mockResolvedValue(messagePage([]));
    render(<TaskDetail />);

    // Task tab active by default: description/timeline visible, no transcript.
    expect(await screen.findByTestId('tab-session-conv-42')).toBeInTheDocument();
    expect(screen.getByTestId('tab-task')).toBeInTheDocument();
    expect(screen.getByText('No description')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Reply to the agent…')).not.toBeInTheDocument();
  });

  it('opens a project-linked conversation that is outside the first page', async () => {
    const linked = sessionLink({ session_id: 'conv-page-51' });
    const task = detail({ linked_sessions: [linked] });
    const deep = { ...mcConversation, id: linked.session_id };
    useProjectsStore.setState({ detailById: { issue_1: task } });
    mockApi.projectsGetIssue.mockResolvedValue(task);
    mockApi.chatListConversations.mockResolvedValue({
      items: [{ ...mcConversation, id: 'first-page' }],
      nextCursor: 'page-2',
      authority: 'gateway',
      gatewayOnline: true,
    });
    mockApi.chatGetConversation.mockImplementation(async (ref: ConversationRef) =>
      ref.origin === 'gateway' && ref.id === deep.id ? deep : null,
    );
    mockApi.chatGetMessages.mockResolvedValue(messagePage([]));

    render(<TaskDetail />);

    expect(await screen.findByTestId('tab-session-conv-page-51')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('tab-session-conv-page-51'));
    await userEvent.click(screen.getByTestId('session-open-chat'));
    expect(mockNavigate).toHaveBeenCalledWith({
      to: '/chat',
      search: { agentId: '', conversationId: 'conv-page-51', origin: 'gateway' },
    });
    expect(mockApi.chatCreateConversation).not.toHaveBeenCalled();
  });

  it('switching to a session tab shows the transcript; Task tab returns', async () => {
    const d = detail({ linked_sessions: [sessionLink()] });
    useProjectsStore.setState({ detailById: { issue_1: d } });
    mockApi.projectsGetIssue.mockResolvedValue(d);
    mockConversations([mcConversation]);
    mockApi.chatGetMessages.mockResolvedValue(
      messagePage([assistantMessage('m1', 'conv-42', 'I loaded TASK-1')]),
    );
    render(<TaskDetail />);

    await userEvent.click(await screen.findByTestId('tab-session-conv-42'));
    expect(await screen.findByText(/I loaded TASK-1/)).toBeInTheDocument();
    expect(screen.queryByText('No description')).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId('tab-task'));
    expect(screen.getByText('No description')).toBeInTheDocument();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('orders session tabs newest-first; external-link opens the active session in Chat', async () => {
    const older = sessionLink({
      session_id: 'conv-41',
      last_referenced_at: '2026-05-01T00:00:00Z',
    });
    const d = detail({ linked_sessions: [older, sessionLink()] });
    useProjectsStore.setState({ detailById: { issue_1: d } });
    mockApi.projectsGetIssue.mockResolvedValue(d);
    mockConversations([mcConversation, { ...mcConversation, id: 'conv-41' }]);
    mockApi.chatGetMessages.mockImplementation(async (ref: ConversationRef) =>
      messagePage([assistantMessage(`m-${ref.id}`, ref.id, `transcript ${ref.id}`)]),
    );
    render(<TaskDetail />);

    const tabs = await screen.findAllByTestId(/^tab-session-/);
    expect(tabs.map((t) => t.getAttribute('data-testid'))).toEqual([
      'tab-session-conv-42',
      'tab-session-conv-41',
    ]);

    await userEvent.click(screen.getByTestId('tab-session-conv-41'));
    expect(await screen.findByText(/transcript conv-41/)).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('session-open-chat'));
    expect(mockNavigate).toHaveBeenCalledWith({
      to: '/chat',
      search: { agentId: '', conversationId: 'conv-41', origin: 'gateway' },
    });
  });

  it('metadata lists only non-MC sessions, muted; MC sessions have no chips', async () => {
    const d = detail({
      linked_sessions: [sessionLink(), sessionLink({ session_id: 'telegram-1' })],
    });
    useProjectsStore.setState({ detailById: { issue_1: d } });
    mockApi.projectsGetIssue.mockResolvedValue(d);
    mockConversations([mcConversation]);
    mockApi.chatGetMessages.mockResolvedValue(messagePage([]));
    render(<TaskDetail />);

    // Non-MC row is a muted, inert span with the other-channel tooltip.
    const row = await screen.findByTitle('Session from another channel');
    expect(row.textContent).toContain('telegram-1');
    // The MC session has a tab, not a chip; the count reflects non-MC only.
    expect(screen.queryByTestId('session-chip-conv-42')).not.toBeInTheDocument();
    expect(screen.getByText('Linked sessions (1)')).toBeInTheDocument();
  });

  it('hides the linked-sessions section when every session is an MC tab', async () => {
    const d = detail({ linked_sessions: [sessionLink()] });
    useProjectsStore.setState({ detailById: { issue_1: d } });
    mockApi.projectsGetIssue.mockResolvedValue(d);
    mockConversations([mcConversation]);
    mockApi.chatGetMessages.mockResolvedValue(messagePage([]));
    render(<TaskDetail />);

    await screen.findByTestId('tab-session-conv-42');
    expect(screen.queryByText(/^Linked sessions/)).not.toBeInTheDocument();
  });

  it('renders no tab bar when the task has no MC sessions', async () => {
    const d = detail({ linked_sessions: [sessionLink({ session_id: 'telegram-1' })] });
    useProjectsStore.setState({ detailById: { issue_1: d } });
    mockApi.projectsGetIssue.mockResolvedValue(d);
    mockConversations([]);
    render(<TaskDetail />);

    expect(await screen.findByText('No description')).toBeInTheDocument();
    expect(screen.queryByTestId('tab-task')).not.toBeInTheDocument();
    expect(screen.queryByTestId('tab-session-telegram-1')).not.toBeInTheDocument();
  });

  it('shows the session tab when the link arrives via broadcast only (no local assign)', async () => {
    // An agent's projects tool or a second MC window links a session: this
    // window only sees the gateway's session.linked broadcast. The tab must
    // appear live — before the fix the conversation list was never reloaded,
    // so the mcSessions filter dropped the link until a re-navigation.
    const before = detail();
    useProjectsStore.setState({ detailById: { issue_1: before } });
    mockApi.projectsGetIssue.mockResolvedValue(before);
    mockConversations([]);
    mockApi.chatGetMessages.mockResolvedValue(messagePage([]));
    render(<TaskDetail />);

    expect(await screen.findByText('No description')).toBeInTheDocument();
    expect(screen.queryByTestId('tab-session-conv-42')).not.toBeInTheDocument();

    // The out-of-band link happened: the refetched detail and conversation
    // list now include it, and the broadcast is the only signal we get.
    const after = detail({ linked_sessions: [sessionLink()] });
    mockApi.projectsGetIssue.mockResolvedValue(after);
    mockConversations([mcConversation]);
    act(() => {
      useProjectsStore
        .getState()
        .applyEvent({ topic: 'session.linked', payload: { issue_id: 'issue_1' } });
    });

    expect(await screen.findByTestId('tab-session-conv-42')).toBeInTheDocument();
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

  it('feeds a posted comment into the active session as a chat message', async () => {
    const d = detail({ linked_sessions: [sessionLink()] });
    useProjectsStore.setState({ detailById: { issue_1: d } });
    mockApi.projectsGetIssue.mockResolvedValue(d);
    mockConversations([mcConversation]);
    mockApi.chatGetMessages.mockResolvedValue(messagePage([]));
    render(<TaskDetail />);

    // The composer shows where the comment will go.
    expect(await screen.findByText(/Also sent to the agent session/)).toBeInTheDocument();

    await userEvent.type(screen.getByPlaceholderText('Add a comment…'), 'ship it');
    await userEvent.click(screen.getByText('Comment'));

    await waitFor(() =>
      expect(mockApi.projectsAddComment).toHaveBeenCalledWith('issue_1', 'ship it'),
    );
    await waitFor(() =>
      expect(mockApi.chatSend).toHaveBeenCalledWith(
        { id: 'conv-42', origin: 'gateway' },
        expect.any(String),
        expect.stringContaining('ship it'),
        undefined,
      ),
    );
    // The feed message carries the task key for agent context.
    expect(mockApi.chatSend.mock.calls[0][2]).toContain('TASK-1');
  });

  it('does not feed the session when none is linked', async () => {
    const d = detail();
    useProjectsStore.setState({ detailById: { issue_1: d } });
    mockApi.projectsGetIssue.mockResolvedValue(d);
    render(<TaskDetail />);

    await userEvent.type(await screen.findByPlaceholderText('Add a comment…'), 'just a note');
    await userEvent.click(screen.getByText('Comment'));

    await waitFor(() =>
      expect(mockApi.projectsAddComment).toHaveBeenCalledWith('issue_1', 'just a note'),
    );
    expect(mockApi.chatSend).not.toHaveBeenCalled();
    expect(screen.queryByText(/Also sent to the agent session/)).not.toBeInTheDocument();
  });

  it('skips the session feed while the agent is mid-run and says so', async () => {
    const d = detail({ linked_sessions: [sessionLink()] });
    useProjectsStore.setState({ detailById: { issue_1: d } });
    useChatStore.setState({ sending: { 'gateway:conv-42': true } });
    mockApi.projectsGetIssue.mockResolvedValue(d);
    mockConversations([{ ...mcConversation, status: 'running', activeTurnId: 'turn-1' }]);
    mockApi.chatGetMessages.mockResolvedValue(messagePage([]));
    render(<TaskDetail />);

    expect(await screen.findByText(/Agent is mid-run/)).toBeInTheDocument();

    await userEvent.type(screen.getByPlaceholderText('Add a comment…'), 'while busy');
    await userEvent.click(screen.getByText('Comment'));

    await waitFor(() =>
      expect(mockApi.projectsAddComment).toHaveBeenCalledWith('issue_1', 'while busy'),
    );
    expect(mockApi.chatSend).not.toHaveBeenCalled();
  });

  it('keeps sessions from other channels as non-clickable chips', async () => {
    const d = detail({ linked_sessions: [sessionLink({ session_id: 'tg-session' })] });
    useProjectsStore.setState({ detailById: { issue_1: d } });
    mockApi.projectsGetIssue.mockResolvedValue(d);
    mockConversations([]);
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
