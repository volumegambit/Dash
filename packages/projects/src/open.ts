import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database, { type Database as DatabaseType } from 'better-sqlite3';
import { ProjectsEmitter } from './events.js';
import { runMigrations } from './migrations/runner.js';
import { InboxStoreSqlite } from './stores/inbox-store-sqlite.js';
import type { InboxStore } from './stores/inbox-store.js';
import { IssueCommentStoreSqlite } from './stores/issue-comment-store-sqlite.js';
import type { IssueCommentStore } from './stores/issue-comment-store.js';
import { IssueEventStoreSqlite } from './stores/issue-event-store-sqlite.js';
import type { IssueEventStore } from './stores/issue-event-store.js';
import { IssueStoreSqlite } from './stores/issue-store-sqlite.js';
import type { IssueStore } from './stores/issue-store.js';
import { ProjectStoreSqlite } from './stores/project-store-sqlite.js';
import type { ProjectStore } from './stores/project-store.js';
import { SessionLinkStoreSqlite } from './stores/session-link-store-sqlite.js';
import type { SessionLinkStore } from './stores/session-link-store.js';

export interface ProjectsDb {
  projects: ProjectStore;
  issues: IssueStore;
  comments: IssueCommentStore;
  events: IssueEventStore;
  sessionLinks: SessionLinkStore;
  inbox: InboxStore;
  emitter: ProjectsEmitter;
  db: DatabaseType;
}

/**
 * Open `data/projects.db` under `dataDir`, apply PRAGMAs + migrations,
 * and wire every store to a single shared `ProjectsEmitter`. This is the
 * composition root for the projects domain — the gateway calls it once
 * and injects the returned stores into the agent runtime and management
 * server. Mirrors the `SqliteEventLogStore` constructor's PRAGMA setup.
 */
export function openProjectsDb(dataDir: string): ProjectsDb {
  const dbPath = join(dataDir, 'projects.db');
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  runMigrations(db);

  const emitter = new ProjectsEmitter();
  const events = new IssueEventStoreSqlite(db, emitter);
  const projects = new ProjectStoreSqlite(db, emitter);
  const issues = new IssueStoreSqlite(db, emitter, events);
  const comments = new IssueCommentStoreSqlite(db, emitter, events);
  const sessionLinks = new SessionLinkStoreSqlite(db, emitter, events);
  const inbox = new InboxStoreSqlite(db);

  return { projects, issues, comments, events, sessionLinks, inbox, emitter, db };
}
