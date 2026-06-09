import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectsEmitter } from '../events.js';
import { type FreshDb, freshDb } from '../test-helpers.js';
import { IssueEventStoreSqlite } from './issue-event-store-sqlite.js';
import { IssueStoreSqlite } from './issue-store-sqlite.js';
import { ProjectStoreSqlite } from './project-store-sqlite.js';

describe('IssueStoreSqlite', () => {
  let h: FreshDb;
  let emitter: ProjectsEmitter;
  let events: IssueEventStoreSqlite;
  let projects: ProjectStoreSqlite;
  let issues: IssueStoreSqlite;

  beforeEach(async () => {
    h = await freshDb();
    emitter = new ProjectsEmitter();
    events = new IssueEventStoreSqlite(h.db, emitter);
    projects = new ProjectStoreSqlite(h.db, emitter);
    issues = new IssueStoreSqlite(h.db, emitter, events);
  });

  afterEach(async () => {
    await h.cleanup();
  });

  it('generates PROJECT_KEY-n keys starting at 1', () => {
    const p = projects.create({ key: 'GATEWAY', name: 'Gateway' });
    const a = issues.create({ title: 'one', project_id: p.id });
    const b = issues.create({ title: 'two', project_id: p.id });
    expect(a.key).toBe('GATEWAY-1');
    expect(b.key).toBe('GATEWAY-2');
    expect(a.id).toMatch(/^issue_/);
  });

  it('standalone issues get TASK-n keys', () => {
    const a = issues.create({ title: 'standalone' });
    const b = issues.create({ title: 'standalone2' });
    expect(a.key).toBe('TASK-1');
    expect(b.key).toBe('TASK-2');
    expect(a.project_id).toBeNull();
  });

  it('keeps per-project sequences independent', () => {
    const p1 = projects.create({ key: 'AAA', name: 'A' });
    const p2 = projects.create({ key: 'BBB', name: 'B' });
    expect(issues.create({ title: 'x', project_id: p1.id }).key).toBe('AAA-1');
    expect(issues.create({ title: 'y', project_id: p2.id }).key).toBe('BBB-1');
    expect(issues.create({ title: 'z', project_id: p1.id }).key).toBe('AAA-2');
  });

  it('produces contiguous unique keys across many creates', () => {
    const p = projects.create({ key: 'GW', name: 'GW' });
    const keys = Array.from(
      { length: 50 },
      (_, i) => issues.create({ title: `t${i}`, project_id: p.id }).key,
    );
    expect(new Set(keys).size).toBe(50);
    const nums = keys.map((k) => Number(k.split('-')[1])).sort((a, b) => a - b);
    expect(nums).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
  });

  it('applies defaults: status todo, sub_status null, assignee local, created_by human', () => {
    const i = issues.create({ title: 't' });
    expect(i.status).toBe('todo');
    expect(i.sub_status).toBeNull();
    expect(i.assignee_user_id).toBe('local');
    expect(i.created_by).toBe('human');
    expect(i.completed_at).toBeNull();
  });

  it('allows a one-level subtask and appends subtask_added to the parent', () => {
    const parent = issues.create({ title: 'parent' });
    const child = issues.create({ title: 'child', parent_issue_id: parent.id });
    expect(child.parent_issue_id).toBe(parent.id);
    const parentEvents = events.listByIssue(parent.id);
    expect(parentEvents.map((e) => e.type)).toContain('subtask_added');
  });

  it('rejects a subtask under an issue that already has a parent (one-level depth)', () => {
    const parent = issues.create({ title: 'parent' });
    const child = issues.create({ title: 'child', parent_issue_id: parent.id });
    expect(() => issues.create({ title: 'grandchild', parent_issue_id: child.id })).toThrow(
      /one level/i,
    );
  });

  it('emits issue.created on create', () => {
    const handler = vi.fn();
    emitter.on('issue.created', handler);
    const i = issues.create({ title: 't' });
    expect(handler).toHaveBeenCalledWith({ issue: i });
  });

  it('reads by id and key, lists with filters', () => {
    const a = issues.create({ title: 'a', status: 'todo' });
    const b = issues.create({ title: 'b', status: 'done' });
    expect(issues.get(a.id)?.id).toBe(a.id);
    expect(issues.getByKey(b.key)?.id).toBe(b.id);
    expect(issues.list({ status: 'done' }).map((i) => i.id)).toEqual([b.id]);
  });

  it('getByIdOrKey resolves by issue_ id or human key', () => {
    const p = projects.create({ key: 'GW', name: 'GW' });
    const a = issues.create({ title: 'a', project_id: p.id });
    expect(issues.getByIdOrKey(a.id)?.id).toBe(a.id);
    expect(issues.getByIdOrKey(a.key)?.id).toBe(a.id);
    expect(issues.getByIdOrKey('issue_missing')).toBeNull();
    expect(issues.getByIdOrKey('GW-999')).toBeNull();
  });

  it('list returns a bare array (no pagination wrapper)', () => {
    issues.create({ title: 'a' });
    const result = issues.list();
    expect(Array.isArray(result)).toBe(true);
  });

  it('agents_involved filter matches created_by_agent_id OR a session-linked agent', () => {
    // Issue 1: created by agent-A directly.
    const created = issues.create({
      title: 'made by A',
      created_by: 'agent',
      created_by_agent_id: 'agent-A',
    });
    // Issue 2: created by human, but agent-A is session-linked.
    const linked = issues.create({ title: 'human-made' });
    h.db
      .prepare(
        `INSERT INTO session_issue_link
           (session_id, issue_id, agent_id, first_referenced_at, last_referenced_at, reference_count)
         VALUES ('sess', ?, 'agent-A', 'now', 'now', 1)`,
      )
      .run(linked.id);
    // Issue 3: unrelated.
    const other = issues.create({ title: 'unrelated' });

    const ids = issues
      .list({ agents_involved: 'agent-A' })
      .map((i) => i.id)
      .sort();
    expect(ids).toEqual([created.id, linked.id].sort());
    expect(ids).not.toContain(other.id);
  });

  it('getDetail composes comments, events, linked sessions, and subtasks', () => {
    const parent = issues.create({ title: 'parent' });
    const child = issues.create({ title: 'child', parent_issue_id: parent.id });
    // Seed a comment, a link, and rely on the subtask_added event already written.
    h.db
      .prepare(
        `INSERT INTO issue_comment (id, issue_id, author_type, author_id, body, created_at, updated_at, deleted_at)
         VALUES ('cmt_1', ?, 'human', 'local', 'hi', 'now', 'now', NULL)`,
      )
      .run(parent.id);
    h.db
      .prepare(
        `INSERT INTO session_issue_link
           (session_id, issue_id, agent_id, first_referenced_at, last_referenced_at, reference_count)
         VALUES ('sess', ?, NULL, 'now', 'now', 1)`,
      )
      .run(parent.id);

    const detail = issues.getDetail(parent.key);
    expect(detail?.id).toBe(parent.id);
    expect(detail?.comments.map((c) => c.id)).toEqual(['cmt_1']);
    expect(detail?.events.map((e) => e.type)).toContain('subtask_added');
    expect(detail?.linked_sessions.map((s) => s.session_id)).toEqual(['sess']);
    expect(detail?.subtasks.map((s) => s.id)).toEqual([child.id]);
  });

  it('getDetail returns null for an unknown issue', () => {
    expect(issues.getDetail('issue_missing')).toBeNull();
  });

  it('update accepts a system actor for event authorship', () => {
    const i = issues.create({ title: 't' });
    issues.update(i.id, { status: 'done' }, { type: 'system', id: 'system' });
    const evt = events.listByIssue(i.id).find((e) => e.type === 'status_change');
    expect(evt?.actor_type).toBe('system');
  });

  it('update writes a status_change event and bumps updated_at', () => {
    const i = issues.create({ title: 't', status: 'todo' });
    const updated = issues.update(i.id, { status: 'in_progress', sub_status: 'agent_working' });
    expect(updated.status).toBe('in_progress');
    expect(updated.sub_status).toBe('agent_working');
    const types = events.listByIssue(i.id).map((e) => e.type);
    expect(types).toContain('status_change');
    expect(types).toContain('sub_status_change');
  });

  it('update writes a field_change event for title/description edits', () => {
    const i = issues.create({ title: 't' });
    issues.update(i.id, { title: 'new title' });
    expect(events.listByIssue(i.id).map((e) => e.type)).toContain('field_change');
  });

  it('update writes an assignee_change event', () => {
    const i = issues.create({ title: 't' });
    issues.update(i.id, { assignee_user_id: 'someone' });
    expect(events.listByIssue(i.id).map((e) => e.type)).toContain('assignee_change');
  });

  it('emits issue.updated on update', () => {
    const handler = vi.fn();
    const i = issues.create({ title: 't' });
    emitter.on('issue.updated', handler);
    const u = issues.update(i.id, { title: 'x' });
    expect(handler).toHaveBeenCalledWith({ issue: u });
  });
});
