import { describe, expect, it } from 'vitest';
import { issuePatchForSessionStatus } from './session-status-sync.js';

describe('issuePatchForSessionStatus', () => {
  it('working on a backlog task promotes to in_progress + agent_working', () => {
    expect(issuePatchForSessionStatus({ status: 'backlog', sub_status: null }, 'working')).toEqual({
      status: 'in_progress',
      sub_status: 'agent_working',
    });
  });

  it('working on a todo task promotes to in_progress + agent_working', () => {
    expect(issuePatchForSessionStatus({ status: 'todo', sub_status: null }, 'working')).toEqual({
      status: 'in_progress',
      sub_status: 'agent_working',
    });
  });

  it('working on an in_progress task only sets sub_status (no status rewrite)', () => {
    expect(
      issuePatchForSessionStatus(
        { status: 'in_progress', sub_status: 'waiting_on_human' },
        'working',
      ),
    ).toEqual({ sub_status: 'agent_working' });
  });

  it('working never rewrites a review status', () => {
    expect(issuePatchForSessionStatus({ status: 'review', sub_status: null }, 'working')).toEqual({
      sub_status: 'agent_working',
    });
  });

  it('needs maps to waiting_on_human without touching status', () => {
    expect(
      issuePatchForSessionStatus({ status: 'in_progress', sub_status: 'agent_working' }, 'needs'),
    ).toEqual({ sub_status: 'waiting_on_human' });
  });

  it('done maps to waiting_on_human without touching status', () => {
    expect(
      issuePatchForSessionStatus({ status: 'in_progress', sub_status: 'agent_working' }, 'done'),
    ).toEqual({ sub_status: 'waiting_on_human' });
  });

  it('error maps to blocked', () => {
    expect(
      issuePatchForSessionStatus({ status: 'in_progress', sub_status: 'agent_working' }, 'error'),
    ).toEqual({ sub_status: 'blocked' });
  });

  it('returns null when the task is already done (never resurrect)', () => {
    expect(issuePatchForSessionStatus({ status: 'done', sub_status: null }, 'working')).toBeNull();
    expect(issuePatchForSessionStatus({ status: 'done', sub_status: null }, 'error')).toBeNull();
  });

  it('returns null when the task is cancelled', () => {
    expect(
      issuePatchForSessionStatus({ status: 'cancelled', sub_status: null }, 'done'),
    ).toBeNull();
  });

  it('returns null when sub_status already matches and no status promotion applies', () => {
    expect(
      issuePatchForSessionStatus({ status: 'in_progress', sub_status: 'agent_working' }, 'working'),
    ).toBeNull();
    expect(
      issuePatchForSessionStatus({ status: 'in_progress', sub_status: 'waiting_on_human' }, 'done'),
    ).toBeNull();
  });
});
