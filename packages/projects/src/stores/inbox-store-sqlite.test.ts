import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectsEmitter } from '../events.js';
import { type FreshDb, freshDb } from '../test-helpers.js';
import { InboxStoreSqlite } from './inbox-store-sqlite.js';
import { IssueEventStoreSqlite } from './issue-event-store-sqlite.js';
import { IssueStoreSqlite } from './issue-store-sqlite.js';
import { ProjectStoreSqlite } from './project-store-sqlite.js';

describe('InboxStoreSqlite', () => {
  let h: FreshDb;
  let emitter: ProjectsEmitter;
  let events: IssueEventStoreSqlite;
  let projects: ProjectStoreSqlite;
  let issues: IssueStoreSqlite;
  let inbox: InboxStoreSqlite;

  beforeEach(async () => {
    h = await freshDb();
    emitter = new ProjectsEmitter();
    events = new IssueEventStoreSqlite(h.db, emitter);
    projects = new ProjectStoreSqlite(h.db, emitter);
    issues = new IssueStoreSqlite(h.db, emitter, events);
    inbox = new InboxStoreSqlite(h.db);
  });

  afterEach(async () => {
    await h.cleanup();
  });

  it('surfaces a waiting_on_human item for the assignee', () => {
    const issue = issues.create({ title: 'blocked on me', assignee_user_id: 'local' });
    issues.update(issue.id, { status: 'in_progress', sub_status: 'waiting_on_human' });
    const items = inbox.list('local');
    const reasons = items.filter((i) => i.issue.id === issue.id).map((i) => i.reason);
    expect(reasons).toContain('waiting_on_human');
  });

  it('surfaces a new_activity item when updated_at is newer than last seen', () => {
    const issue = issues.create({ title: 'updated', assignee_user_id: 'local' });
    // No inbox_read row yet → counts as unseen activity.
    const items = inbox.list('local');
    expect(items.some((i) => i.issue.id === issue.id && i.reason === 'new_activity')).toBe(true);
  });

  it('excludes issues assigned to a different user', () => {
    const mine = issues.create({ title: 'mine', assignee_user_id: 'local' });
    issues.create({ title: 'theirs', assignee_user_id: 'someone-else' });
    const ids = inbox.list('local').map((i) => i.issue.id);
    expect(ids).toContain(mine.id);
    expect(ids.every((id) => id === mine.id)).toBe(true);
  });

  it('markRead suppresses new_activity until the issue updates again', async () => {
    const issue = issues.create({ title: 'seen it', assignee_user_id: 'local' });
    inbox.markRead(issue.id);
    expect(
      inbox.list('local').some((i) => i.issue.id === issue.id && i.reason === 'new_activity'),
    ).toBe(false);
    await new Promise((r) => setTimeout(r, 5));
    issues.update(issue.id, { title: 'changed' });
    expect(
      inbox.list('local').some((i) => i.issue.id === issue.id && i.reason === 'new_activity'),
    ).toBe(true);
  });

  it('markRead upserts (calling twice does not error and keeps one row)', () => {
    const issue = issues.create({ title: 'x', assignee_user_id: 'local' });
    inbox.markRead(issue.id);
    inbox.markRead(issue.id);
    const count = h.db
      .prepare('SELECT COUNT(*) AS c FROM inbox_read WHERE issue_id = ?')
      .get(issue.id) as { c: number };
    expect(count.c).toBe(1);
  });

  it('resolves the project for items in a project', () => {
    const p = projects.create({ key: 'GW', name: 'Gateway' });
    const issue = issues.create({ title: 'pf', project_id: p.id, assignee_user_id: 'local' });
    issues.update(issue.id, { status: 'in_progress', sub_status: 'waiting_on_human' });
    const item = inbox.list('local').find((i) => i.issue.id === issue.id);
    expect(item?.project?.id).toBe(p.id);
  });
});
