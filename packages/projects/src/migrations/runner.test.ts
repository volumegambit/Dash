import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database, { type Database as DatabaseType } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from './runner.js';

describe('runMigrations', () => {
  let tmpDir: string;
  let db: DatabaseType;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'projects-migrate-'));
    db = new Database(join(tmpDir, 'projects.db'));
    db.pragma('foreign_keys = ON');
  });

  afterEach(async () => {
    db.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  function tableNames(): string[] {
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as { name: string }[];
    return rows.map((r) => r.name);
  }

  it('applies 001 and creates the expected tables', () => {
    runMigrations(db);
    const names = tableNames();
    for (const t of [
      'project',
      'issue',
      'issue_comment',
      'issue_event',
      'session_issue_link',
      'project_issue_seq',
      'inbox_read',
      'schema_version',
    ]) {
      expect(names).toContain(t);
    }
  });

  it('records the applied version in schema_version', () => {
    runMigrations(db);
    const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number };
    expect(row.v).toBe(1);
  });

  it('is idempotent — running twice is a no-op', () => {
    runMigrations(db);
    expect(() => runMigrations(db)).not.toThrow();
    const row = db.prepare('SELECT COUNT(*) AS c FROM schema_version').get() as { c: number };
    expect(row.c).toBe(1);
  });

  it('001 schema includes agent_id column and index in session_issue_link', () => {
    runMigrations(db);
    const cols = db.prepare("SELECT name FROM pragma_table_info('session_issue_link')").all() as {
      name: string;
    }[];
    expect(cols.map((c) => c.name)).toContain('agent_id');
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as {
      name: string;
    }[];
    expect(indexes.map((i) => i.name)).toContain('session_link_by_agent');
  });
});
