import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectsEmitter } from '../events.js';
import { type FreshDb, freshDb } from '../test-helpers.js';
import { ProjectStoreSqlite } from './project-store-sqlite.js';

describe('ProjectStoreSqlite', () => {
  let h: FreshDb;
  let emitter: ProjectsEmitter;
  let store: ProjectStoreSqlite;

  beforeEach(async () => {
    h = await freshDb();
    emitter = new ProjectsEmitter();
    store = new ProjectStoreSqlite(h.db, emitter);
  });

  afterEach(async () => {
    await h.cleanup();
  });

  it('creates a project with defaults and a proj_ id', () => {
    const p = store.create({ key: 'GATEWAY', name: 'Gateway' });
    expect(p.id).toMatch(/^proj_/);
    expect(p.key).toBe('GATEWAY');
    expect(p.description).toBe('');
    expect(p.status).toBe('active');
    expect(p.archived_at).toBeNull();
    expect(p.created_at).toBe(p.updated_at);
  });

  it('reads back by id and by key', () => {
    const p = store.create({ key: 'GW', name: 'Gateway' });
    expect(store.get(p.id)).toEqual(p);
    expect(store.getByKey('GW')).toEqual(p);
    expect(store.get('proj_missing')).toBeNull();
  });

  it('getByIdOrKey resolves by proj_ id or by human key', () => {
    const p = store.create({ key: 'GW', name: 'Gateway' });
    expect(store.getByIdOrKey(p.id)?.id).toBe(p.id);
    expect(store.getByIdOrKey('GW')?.id).toBe(p.id);
    expect(store.getByIdOrKey('proj_missing')).toBeNull();
    expect(store.getByIdOrKey('NOPE')).toBeNull();
  });

  it('getWithCounts returns zero-filled status counts and tallies issues', () => {
    const p = store.create({ key: 'GW', name: 'Gateway' });
    // Seed issues directly to avoid coupling to IssueStore in this test.
    const seed = (status: string) =>
      h.db
        .prepare(
          `INSERT INTO issue (id, key, project_id, title, status, assignee_user_id, created_by, created_at, updated_at)
           VALUES (?, ?, ?, 't', ?, 'local', 'human', 'now', 'now')`,
        )
        .run(`issue_${status}_${Math.random()}`, `GW-${Math.random()}`, p.id, status);
    seed('todo');
    seed('todo');
    seed('done');
    const wc = store.getWithCounts('GW');
    expect(wc?.id).toBe(p.id);
    expect(wc?.issue_counts_by_status.todo).toBe(2);
    expect(wc?.issue_counts_by_status.done).toBe(1);
    expect(wc?.issue_counts_by_status.backlog).toBe(0);
    expect(wc?.issue_counts_by_status.in_progress).toBe(0);
    expect(wc?.issue_counts_by_status.review).toBe(0);
    expect(wc?.issue_counts_by_status.cancelled).toBe(0);
  });

  it('getWithCounts returns null for an unknown project', () => {
    expect(store.getWithCounts('proj_missing')).toBeNull();
  });

  it('lists projects, optionally filtered by status', () => {
    const a = store.create({ key: 'A', name: 'A' });
    const b = store.create({ key: 'B', name: 'B', status: 'paused' });
    expect(store.list().map((p) => p.id).sort()).toEqual([a.id, b.id].sort());
    expect(store.list({ status: 'paused' }).map((p) => p.id)).toEqual([b.id]);
  });

  it('updates fields and bumps updated_at', async () => {
    const p = store.create({ key: 'A', name: 'A' });
    await new Promise((r) => setTimeout(r, 2));
    const updated = store.update(p.id, { name: 'Renamed', status: 'completed' });
    expect(updated.name).toBe('Renamed');
    expect(updated.status).toBe('completed');
    expect(updated.updated_at >= p.updated_at).toBe(true);
  });

  it('emits project.created and project.updated', () => {
    const created = vi.fn();
    const updatedFn = vi.fn();
    emitter.on('project.created', created);
    emitter.on('project.updated', updatedFn);
    const p = store.create({ key: 'A', name: 'A' });
    expect(created).toHaveBeenCalledWith({ project: p });
    const u = store.update(p.id, { name: 'B' });
    expect(updatedFn).toHaveBeenCalledWith({ project: u });
  });
});
