import { describe, expect, it } from 'vitest';
import type { Issue, IssueStatus, IssueSubStatus } from '../../../../../shared/projects-ipc.js';
import {
  IN_PROGRESS_SECTIONS,
  KANBAN_COLUMNS,
  bucketByStatus,
  bucketInProgress,
} from './kanban.js';

function issue(id: string, status: IssueStatus, sub: IssueSubStatus = null): Issue {
  return {
    id,
    key: `T-${id}`,
    project_id: null,
    parent_issue_id: null,
    title: id,
    description: '',
    status,
    sub_status: sub,
    assignee_user_id: 'me',
    created_by: 'human',
    created_by_agent_id: null,
    created_at: '',
    updated_at: '',
    completed_at: null,
  };
}

describe('kanban columns', () => {
  it('defines the five status columns in order', () => {
    expect(KANBAN_COLUMNS).toEqual(['backlog', 'todo', 'in_progress', 'review', 'done']);
  });

  it('defines In Progress sections with waiting_on_human first', () => {
    expect(IN_PROGRESS_SECTIONS).toEqual(['waiting_on_human', 'agent_working', 'blocked']);
  });

  it('buckets issues by status column', () => {
    const cols = bucketByStatus([issue('1', 'todo'), issue('2', 'done'), issue('3', 'todo')]);
    expect(cols.todo.map((i) => i.id)).toEqual(['1', '3']);
    expect(cols.done.map((i) => i.id)).toEqual(['2']);
    expect(cols.backlog).toEqual([]);
  });

  it('splits In Progress issues into ordered sub-status sections; null sub-status falls into agent_working bucket fallback', () => {
    const sections = bucketInProgress([
      issue('1', 'in_progress', 'blocked'),
      issue('2', 'in_progress', 'waiting_on_human'),
      issue('3', 'in_progress', 'agent_working'),
    ]);
    expect(sections.waiting_on_human.map((i) => i.id)).toEqual(['2']);
    expect(sections.agent_working.map((i) => i.id)).toEqual(['3']);
    expect(sections.blocked.map((i) => i.id)).toEqual(['1']);
  });
});
