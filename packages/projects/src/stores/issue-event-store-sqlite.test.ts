import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectsEmitter } from '../events.js';
import { type FreshDb, freshDb } from '../test-helpers.js';
import { IssueEventStoreSqlite } from './issue-event-store-sqlite.js';

// Insert a bare issue row directly so FK constraints are satisfied.
function seedIssue(h: FreshDb, id: string): void {
  h.db
    .prepare(
      `INSERT INTO issue (id, key, title, status, assignee_user_id, created_by, created_at, updated_at)
       VALUES (?, ?, 't', 'todo', 'local', 'human', 'now', 'now')`,
    )
    .run(id, id);
}

describe('IssueEventStoreSqlite', () => {
  let h: FreshDb;
  let emitter: ProjectsEmitter;
  let store: IssueEventStoreSqlite;

  beforeEach(async () => {
    h = await freshDb();
    emitter = new ProjectsEmitter();
    store = new IssueEventStoreSqlite(h.db, emitter);
    seedIssue(h, 'issue_1');
  });

  afterEach(async () => {
    await h.cleanup();
  });

  it('appends an event with an evt_ id and serialized data', () => {
    const e = store.append({
      issue_id: 'issue_1',
      type: 'status_change',
      actor_type: 'human',
      actor_id: 'local',
      data: { from: 'todo', to: 'in_progress' },
    });
    expect(e.id).toMatch(/^evt_/);
    expect(e.data).toBe('{"from":"todo","to":"in_progress"}');
  });

  it('defaults data to {}', () => {
    const e = store.append({
      issue_id: 'issue_1',
      type: 'subtask_added',
      actor_type: 'system',
      actor_id: 'system',
    });
    expect(e.data).toBe('{}');
  });

  it('lists events for an issue in chronological order', () => {
    store.append({ issue_id: 'issue_1', type: 'status_change', actor_type: 'human', actor_id: 'x' });
    store.append({ issue_id: 'issue_1', type: 'field_change', actor_type: 'human', actor_id: 'x' });
    const events = store.listByIssue('issue_1');
    expect(events.map((e) => e.type)).toEqual(['status_change', 'field_change']);
  });

  it('emits issue.event.appended', () => {
    const handler = vi.fn();
    emitter.on('issue.event.appended', handler);
    const e = store.append({
      issue_id: 'issue_1',
      type: 'assignee_change',
      actor_type: 'human',
      actor_id: 'x',
    });
    expect(handler).toHaveBeenCalledWith({ event: e });
  });
});
