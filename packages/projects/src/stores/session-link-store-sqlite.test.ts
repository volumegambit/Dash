import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectsEmitter } from '../events.js';
import { type FreshDb, freshDb } from '../test-helpers.js';
import { IssueEventStoreSqlite } from './issue-event-store-sqlite.js';
import { SessionLinkStoreSqlite } from './session-link-store-sqlite.js';

function seedIssue(h: FreshDb, id: string): void {
  h.db
    .prepare(
      `INSERT INTO issue (id, key, title, status, assignee_user_id, created_by, created_at, updated_at)
       VALUES (?, ?, 't', 'todo', 'local', 'human', 'now', 'now')`,
    )
    .run(id, id);
}

describe('SessionLinkStoreSqlite', () => {
  let h: FreshDb;
  let emitter: ProjectsEmitter;
  let events: IssueEventStoreSqlite;
  let links: SessionLinkStoreSqlite;

  beforeEach(async () => {
    h = await freshDb();
    emitter = new ProjectsEmitter();
    events = new IssueEventStoreSqlite(h.db, emitter);
    links = new SessionLinkStoreSqlite(h.db, emitter, events);
    seedIssue(h, 'issue_1');
  });

  afterEach(async () => {
    await h.cleanup();
  });

  it('first link inserts with reference_count 1 and null agent_id by default', () => {
    const link = links.link('sess_1', 'issue_1');
    expect(link.reference_count).toBe(1);
    expect(link.agent_id).toBeNull();
    expect(link.first_referenced_at).toBe(link.last_referenced_at);
  });

  it('persists agent_id on first link', () => {
    const link = links.link('sess_1', 'issue_1', 'agent-A');
    expect(link.agent_id).toBe('agent-A');
  });

  it('backfills agent_id on re-link when it was previously null', () => {
    links.link('sess_1', 'issue_1');
    const second = links.link('sess_1', 'issue_1', 'agent-A');
    expect(second.agent_id).toBe('agent-A');
    expect(second.reference_count).toBe(2);
  });

  it('does not overwrite an existing agent_id with null on re-link', () => {
    links.link('sess_1', 'issue_1', 'agent-A');
    const second = links.link('sess_1', 'issue_1');
    expect(second.agent_id).toBe('agent-A');
  });

  it('first link emits session.linked and appends a session_linked event', () => {
    const handler = vi.fn();
    emitter.on('session.linked', handler);
    links.link('sess_1', 'issue_1');
    expect(handler).toHaveBeenCalledTimes(1);
    expect(events.listByIssue('issue_1').map((e) => e.type)).toEqual(['session_linked']);
  });

  it('subsequent links increment reference_count and bump last_referenced_at', async () => {
    const first = links.link('sess_1', 'issue_1');
    await new Promise((r) => setTimeout(r, 2));
    const second = links.link('sess_1', 'issue_1');
    expect(second.reference_count).toBe(2);
    expect(second.first_referenced_at).toBe(first.first_referenced_at);
    expect(second.last_referenced_at >= first.last_referenced_at).toBe(true);
  });

  it('does not emit or append again on subsequent links', () => {
    const handler = vi.fn();
    emitter.on('session.linked', handler);
    links.link('sess_1', 'issue_1');
    links.link('sess_1', 'issue_1');
    expect(handler).toHaveBeenCalledTimes(1);
    expect(events.listByIssue('issue_1')).toHaveLength(1);
  });

  it('lists links by issue and by session', () => {
    links.link('sess_1', 'issue_1');
    links.link('sess_2', 'issue_1');
    expect(links.listByIssue('issue_1').map((l) => l.session_id).sort()).toEqual([
      'sess_1',
      'sess_2',
    ]);
    expect(links.listBySession('sess_1').map((l) => l.issue_id)).toEqual(['issue_1']);
  });
});
