import { beforeEach, describe, expect, it } from 'vitest';
import { mockApi } from '../../../../vitest.setup.js';
import type { Issue, IssueDetail, Project } from '../../../shared/projects-ipc.js';
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

beforeEach(() => {
  useProjectsStore.setState({ issuesById: {}, projectsById: {}, inbox: [], detailById: {} });
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
});

describe('useProjectsStore.subscribe', () => {
  it('subscribes once and forwards frames to applyEvent', () => {
    useProjectsStore.setState({ subscribed: false });
    let captured: ((e: { topic: string; payload: Record<string, unknown> }) => void) | null = null;
    mockApi.onProjectsEvent.mockImplementation((cb: typeof captured) => {
      captured = cb;
      return () => {};
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
  });
});
