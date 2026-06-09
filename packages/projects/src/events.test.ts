import { describe, expect, it, vi } from 'vitest';
import { ProjectsEmitter } from './events.js';
import type { Issue } from './types.js';

function fakeIssue(): Issue {
  return {
    id: 'issue_x',
    key: 'TASK-1',
    project_id: null,
    parent_issue_id: null,
    title: 't',
    description: '',
    status: 'todo',
    sub_status: null,
    assignee_user_id: 'local',
    created_by: 'human',
    created_by_agent_id: null,
    created_at: 'now',
    updated_at: 'now',
    completed_at: null,
  };
}

describe('ProjectsEmitter', () => {
  it('delivers a typed payload to a listener', () => {
    const emitter = new ProjectsEmitter();
    const handler = vi.fn();
    emitter.on('issue.created', handler);
    const issue = fakeIssue();
    emitter.emit('issue.created', { issue });
    expect(handler).toHaveBeenCalledWith({ issue });
  });

  it('supports off() to remove a listener', () => {
    const emitter = new ProjectsEmitter();
    const handler = vi.fn();
    emitter.on('comment.deleted', handler);
    emitter.off('comment.deleted', handler);
    emitter.emit('comment.deleted', { issueId: 'i', commentId: 'c' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('does not throw when emitting with no listeners', () => {
    const emitter = new ProjectsEmitter();
    expect(() =>
      emitter.emit('session.linked', {
        issueId: 'i',
        sessionId: 's',
        link: {
          session_id: 's',
          issue_id: 'i',
          agent_id: null,
          first_referenced_at: 'now',
          last_referenced_at: 'now',
          reference_count: 1,
        },
      }),
    ).not.toThrow();
  });
});
