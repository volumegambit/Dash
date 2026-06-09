import { describe, expect, it } from 'vitest';
import type { InboxItem, Issue } from '../../../../../shared/projects-ipc.js';
import { groupInbox } from './inbox.js';

function issue(id: string): Issue {
  return {
    id,
    key: `T-${id}`,
    project_id: null,
    parent_issue_id: null,
    title: id,
    description: '',
    status: 'in_progress',
    sub_status: 'waiting_on_human',
    assignee_user_id: 'me',
    created_by: 'agent',
    created_by_agent_id: 'a1',
    created_at: '2026-06-01T00:00:00Z',
    updated_at: '2026-06-01T00:00:00Z',
    completed_at: null,
  };
}
function item(id: string, reason: InboxItem['reason']): InboxItem {
  return { issue: issue(id), project: null, reason, trigger_at: '2026-06-01T00:00:00Z' };
}

describe('groupInbox', () => {
  it('splits items into waitingOnYou and newActivity by reason', () => {
    // Data value is 'waiting_on_human' (heading label is "Waiting on you").
    const { waitingOnYou, newActivity } = groupInbox([
      item('1', 'waiting_on_human'),
      item('2', 'new_activity'),
      item('3', 'waiting_on_human'),
    ]);
    expect(waitingOnYou.map((i) => i.issue.id)).toEqual(['1', '3']);
    expect(newActivity.map((i) => i.issue.id)).toEqual(['2']);
  });

  it('returns empty groups for an empty inbox', () => {
    expect(groupInbox([])).toEqual({ waitingOnYou: [], newActivity: [] });
  });
});
