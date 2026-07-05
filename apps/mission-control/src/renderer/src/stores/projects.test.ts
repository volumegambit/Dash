import type { McConversation } from '@dash/mc';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockApi } from '../../../../vitest.setup.js';
import type { Issue, IssueDetail, Project } from '../../../shared/projects-ipc.js';
import { useChatStore } from './chat.js';
import { useProjectsStore } from './projects.js';

function issue(id: string, patch: Partial<Issue> = {}): Issue {
  return {
    id,
    key: `T-${id}`,
    project_id: null,
    parent_issue_id: null,
    title: id,
    description: '',
    status: 'todo',
    sub_status: null,
    assignee_user_id: 'me',
    created_by: 'human',
    created_by_agent_id: null,
    created_at: '2026-06-01T00:00:00Z',
    updated_at: '2026-06-01T00:00:00Z',
    completed_at: null,
    ...patch,
  };
}

function project(id: string, patch: Partial<Project> = {}): Project {
  return {
    id,
    key: `P-${id}`,
    name: id,
    description: '',
    status: 'active',
    created_at: '2026-06-01T00:00:00Z',
    updated_at: '2026-06-01T00:00:00Z',
    archived_at: null,
    ...patch,
  };
}

function conversation(id: string): McConversation {
  return {
    id,
    agentId: 'Developer',
    title: id,
    createdAt: '2026-07-05T00:00:00Z',
    updatedAt: '2026-07-05T00:00:00Z',
  };
}

beforeEach(() => {
  useProjectsStore.setState({ issuesById: {}, projectsById: {}, inbox: [], detailById: {} });
  useChatStore.setState({ conversations: [] });
});

describe('useProjectsStore.applyEvent', () => {
  it('inserts an issue on issue.created', () => {
    useProjectsStore.getState().applyEvent({
      topic: 'issue.created',
      payload: issue('1') as unknown as Record<string, unknown>,
    });
    expect(useProjectsStore.getState().issuesById['1']?.key).toBe('T-1');
  });

  it('replaces the issue on issue.updated (last-write-by-id wins)', () => {
    useProjectsStore.setState({ issuesById: { '1': issue('1', { title: 'old' }) } });
    useProjectsStore.getState().applyEvent({
      topic: 'issue.updated',
      payload: issue('1', { title: 'new' }) as unknown as Record<string, unknown>,
    });
    expect(useProjectsStore.getState().issuesById['1']?.title).toBe('new');
  });

  it('upserts a project on project.created', () => {
    useProjectsStore.getState().applyEvent({
      topic: 'project.created',
      payload: project('p1', { name: 'Alpha' }) as unknown as Record<string, unknown>,
    });
    expect(useProjectsStore.getState().projectsById.p1?.name).toBe('Alpha');
  });

  it('replaces a project on project.updated (last-write-by-id wins)', () => {
    useProjectsStore.setState({ projectsById: { p1: project('p1', { name: 'old' }) } });
    useProjectsStore.getState().applyEvent({
      topic: 'project.updated',
      payload: project('p1', { name: 'new' }) as unknown as Record<string, unknown>,
    });
    expect(useProjectsStore.getState().projectsById.p1?.name).toBe('new');
  });

  it('reads payload as the bare entity (no payload.issue/payload.project unwrap)', () => {
    // Guards against regressing to payload.issue / payload.data shapes.
    useProjectsStore.getState().applyEvent({
      topic: 'issue.created',
      payload: { issue: issue('99') } as unknown as Record<string, unknown>,
    });
    // The frame is entity-shaped, so a wrapped frame has no `id` and is ignored.
    expect(useProjectsStore.getState().issuesById['99']).toBeUndefined();
  });

  it('ignores issue.* / project.* frames without an id', () => {
    expect(() =>
      useProjectsStore.getState().applyEvent({ topic: 'issue.updated', payload: {} }),
    ).not.toThrow();
    expect(() =>
      useProjectsStore.getState().applyEvent({ topic: 'project.updated', payload: {} }),
    ).not.toThrow();
    expect(Object.keys(useProjectsStore.getState().issuesById)).toHaveLength(0);
    expect(Object.keys(useProjectsStore.getState().projectsById)).toHaveLength(0);
  });

  it('refetches the affected issue detail on comment.added when it is cached', () => {
    const detail = { ...issue('1'), comments: [], events: [], linked_sessions: [], subtasks: [] };
    useProjectsStore.setState({ detailById: { '1': detail as IssueDetail } });
    mockApi.projectsGetIssue.mockResolvedValue({ ...detail, title: 'refetched' });
    useProjectsStore.getState().applyEvent({
      topic: 'comment.added',
      payload: { issue_id: '1' },
    });
    expect(mockApi.projectsGetIssue).toHaveBeenCalledWith('1');
  });

  it('does NOT refetch detail when the issue is not cached', () => {
    useProjectsStore.getState().applyEvent({
      topic: 'comment.added',
      payload: { issue_id: 'not-open' },
    });
    expect(mockApi.projectsGetIssue).not.toHaveBeenCalled();
  });

  it.each([
    'issue.event.appended',
    'comment.added',
    'comment.edited',
    'comment.deleted',
    'session.linked',
  ] as const)('refetches cached detail on %s', (topic) => {
    const detail = { ...issue('1'), comments: [], events: [], linked_sessions: [], subtasks: [] };
    useProjectsStore.setState({ detailById: { '1': detail as IssueDetail } });
    useProjectsStore.getState().applyEvent({ topic, payload: { issue_id: '1' } });
    expect(mockApi.projectsGetIssue).toHaveBeenCalledWith('1');
  });

  it('ignores issue_id frames with no issue_id without throwing', () => {
    expect(() =>
      useProjectsStore.getState().applyEvent({ topic: 'comment.added', payload: {} }),
    ).not.toThrow();
    expect(mockApi.projectsGetIssue).not.toHaveBeenCalled();
  });

  it('refreshes the chat conversation list on session.linked even when the detail is not cached', async () => {
    // Broadcast-only link paths (agent projects tool, second MC window) create
    // a conversation this window has never loaded; the task page's session
    // tabs filter linked_sessions by the chat store's list, so the store must
    // refresh it — no component ever calls loadConversations for these.
    mockApi.chatListConversations.mockResolvedValue([conversation('sess-1')]);

    useProjectsStore.getState().applyEvent({
      topic: 'session.linked',
      payload: { issue_id: 'not-cached' },
    });

    expect(mockApi.chatListConversations).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(useChatStore.getState().conversations.map((c) => c.id)).toEqual(['sess-1']);
    });
  });

  it('refreshes both the cached detail and the conversation list on session.linked', async () => {
    const detail = { ...issue('1'), comments: [], events: [], linked_sessions: [], subtasks: [] };
    useProjectsStore.setState({ detailById: { '1': detail as IssueDetail } });
    mockApi.chatListConversations.mockResolvedValue([conversation('sess-1')]);

    useProjectsStore.getState().applyEvent({ topic: 'session.linked', payload: { issue_id: '1' } });

    expect(mockApi.projectsGetIssue).toHaveBeenCalledWith('1');
    expect(mockApi.chatListConversations).toHaveBeenCalledTimes(1);
  });

  it.each(['issue.event.appended', 'comment.added', 'comment.edited', 'comment.deleted'] as const)(
    'does NOT refresh the conversation list on %s',
    (topic) => {
      useProjectsStore.getState().applyEvent({ topic, payload: { issue_id: '1' } });
      expect(mockApi.chatListConversations).not.toHaveBeenCalled();
    },
  );

  it('removes the issue, its cached children, its detail, and its inbox row on issue.deleted', () => {
    const parent = issue('1');
    const child = issue('2', { parent_issue_id: '1' });
    const other = issue('3');
    useProjectsStore.setState({
      issuesById: { '1': parent, '2': child, '3': other },
      detailById: {
        '1': { ...parent, comments: [], events: [], linked_sessions: [], subtasks: [child] },
      },
      inbox: [
        { issue: parent, project: null, reason: 'new_activity', trigger_at: 'now' },
        { issue: other, project: null, reason: 'new_activity', trigger_at: 'now' },
      ],
    });

    useProjectsStore.getState().applyEvent({
      topic: 'issue.deleted',
      payload: parent as unknown as Record<string, unknown>,
    });

    const s = useProjectsStore.getState();
    expect(s.issuesById['1']).toBeUndefined();
    expect(s.issuesById['2']).toBeUndefined();
    expect(s.issuesById['3']).toBeDefined();
    expect(s.detailById['1']).toBeUndefined();
    expect(s.inbox.map((it) => it.issue.id)).toEqual(['3']);
  });

  it('refetches the parent detail when a deleted subtask has a cached parent', () => {
    const parent = issue('1');
    const child = issue('2', { parent_issue_id: '1' });
    const parentDetail = {
      ...parent,
      comments: [],
      events: [],
      linked_sessions: [],
      subtasks: [child],
    };
    useProjectsStore.setState({
      issuesById: { '1': parent, '2': child },
      detailById: { '1': parentDetail as IssueDetail },
    });
    mockApi.projectsGetIssue.mockResolvedValue({ ...parentDetail, subtasks: [] });

    useProjectsStore.getState().applyEvent({
      topic: 'issue.deleted',
      payload: child as unknown as Record<string, unknown>,
    });

    expect(useProjectsStore.getState().issuesById['2']).toBeUndefined();
    expect(mockApi.projectsGetIssue).toHaveBeenCalledWith('1');
  });

  it('ignores an issue.deleted frame without an id', () => {
    expect(() =>
      useProjectsStore.getState().applyEvent({ topic: 'issue.deleted', payload: {} }),
    ).not.toThrow();
  });
});

describe('useProjectsStore.deleteIssue', () => {
  it('calls the API and removes the issue and its children from the store', async () => {
    const parent = issue('1');
    const child = issue('2', { parent_issue_id: '1' });
    const other = issue('3');
    useProjectsStore.setState({
      issuesById: { '1': parent, '2': child, '3': other },
      detailById: {
        '1': { ...parent, comments: [], events: [], linked_sessions: [], subtasks: [child] },
      },
      inbox: [{ issue: child, project: null, reason: 'new_activity', trigger_at: 'now' }],
    });

    await useProjectsStore.getState().deleteIssue('1');

    expect(mockApi.projectsDeleteIssue).toHaveBeenCalledWith('1');
    const s = useProjectsStore.getState();
    expect(s.issuesById['1']).toBeUndefined();
    expect(s.issuesById['2']).toBeUndefined();
    expect(s.issuesById['3']).toBeDefined();
    expect(s.detailById['1']).toBeUndefined();
    expect(s.inbox).toEqual([]);
  });

  it('keeps the issue and surfaces the error when the API rejects', async () => {
    const doomed = issue('1');
    useProjectsStore.setState({ issuesById: { '1': doomed } });
    mockApi.projectsDeleteIssue.mockRejectedValue(new Error('gateway down'));

    await expect(useProjectsStore.getState().deleteIssue('1')).rejects.toThrow('gateway down');

    expect(useProjectsStore.getState().issuesById['1']).toBeDefined();
    expect(useProjectsStore.getState().error).toBe('gateway down');
  });
});

describe('useProjectsStore.assignAgent', () => {
  it('dispatches via the API and refetches the issue detail', async () => {
    const d = { ...issue('1'), comments: [], events: [], linked_sessions: [], subtasks: [] };
    useProjectsStore.setState({ detailById: { '1': d as IssueDetail } });
    mockApi.projectsGetIssue.mockResolvedValue(d);

    await useProjectsStore.getState().assignAgent('1', { id: 'agent-reg', name: 'Developer' });

    expect(mockApi.projectsAssignAgent).toHaveBeenCalledWith('1', 'agent-reg', 'Developer');
    // Immediate refetch so sub-status/linked-session feedback doesn't wait on WS.
    expect(mockApi.projectsGetIssue).toHaveBeenCalledWith('1');
  });

  it('surfaces the error when the dispatch fails', async () => {
    mockApi.projectsAssignAgent.mockRejectedValue(new Error('no gateway'));

    await expect(
      useProjectsStore.getState().assignAgent('1', { id: 'a', name: 'A' }),
    ).rejects.toThrow('no gateway');

    expect(useProjectsStore.getState().error).toBe('no gateway');
  });
});

describe('useProjectsStore.subscribe', () => {
  it('subscribes once and forwards frames to applyEvent', () => {
    useProjectsStore.setState({ subscribed: false });
    // `captured` is assigned synchronously inside mockImplementation when
    // subscribe() runs. The cast keeps its type as the full union so the
    // optional calls below aren't narrowed to `null` (TS can't see the
    // callback assignment, only the `null` initializer).
    type CapturedFrame = (e: { topic: string; payload: Record<string, unknown> }) => void;
    let captured: CapturedFrame | null = null as CapturedFrame | null;
    mockApi.onProjectsEvent.mockImplementation((cb: typeof captured) => {
      captured = cb;
      // The real preload removes the IPC listener on unsub; model that by
      // detaching the captured callback so later frames no longer dispatch.
      return () => {
        captured = null;
      };
    });

    const unsub = useProjectsStore.getState().subscribe();
    expect(mockApi.onProjectsEvent).toHaveBeenCalledTimes(1);
    expect(useProjectsStore.getState().subscribed).toBe(true);

    captured?.({
      topic: 'issue.created',
      payload: issue('7') as unknown as Record<string, unknown>,
    });
    expect(useProjectsStore.getState().issuesById['7']?.key).toBe('T-7');

    // Calling subscribe again is a no-op while already subscribed.
    useProjectsStore.getState().subscribe();
    expect(mockApi.onProjectsEvent).toHaveBeenCalledTimes(1);

    unsub();
    expect(useProjectsStore.getState().subscribed).toBe(false);

    // After unsub, frames no longer reach the store (listener detached).
    captured?.({
      topic: 'issue.created',
      payload: issue('8') as unknown as Record<string, unknown>,
    });
    expect(useProjectsStore.getState().issuesById['8']).toBeUndefined();
  });
});
