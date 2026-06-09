import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database, { type Database as DatabaseType } from 'better-sqlite3';
import { runMigrations } from './migrations/runner.js';

export interface FreshDb {
  db: DatabaseType;
  dir: string;
  cleanup: () => Promise<void>;
}

/**
 * Open a migrated, foreign-keys-on SQLite database in a fresh temp dir.
 * Mirrors the mkdtemp-per-test pattern from
 * `apps/gateway/src/event-log-store-sqlite.test.ts`.
 */
export async function freshDb(): Promise<FreshDb> {
  const dir = await mkdtemp(join(tmpdir(), 'projects-store-'));
  const db = new Database(join(dir, 'projects.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return {
    db,
    dir,
    cleanup: async () => {
      db.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
