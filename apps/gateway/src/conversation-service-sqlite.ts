import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import Database, { type Database as DatabaseType } from 'better-sqlite3';
import { SqliteEventLogStore } from './event-log-store-sqlite.js';
import type { EventLogStore } from './event-log-store.js';

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS conversations (
    id                  TEXT PRIMARY KEY,
    create_request_id   TEXT NOT NULL UNIQUE,
    agent_id            TEXT NOT NULL,
    agent_name_snapshot TEXT NOT NULL,
    title               TEXT NOT NULL DEFAULT 'New Conversation',
    revision            INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
    status              TEXT NOT NULL CHECK (status IN ('idle','running','interrupted','archived','deleted')),
    active_turn_id      TEXT,
    owning_issue_id     TEXT,
    project_id          TEXT,
    last_seq            INTEGER NOT NULL DEFAULT 0 CHECK (last_seq >= 0),
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL,
    deleted_at          TEXT
  );

  CREATE INDEX IF NOT EXISTS conversations_list_idx
    ON conversations(updated_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS conversations_agent_list_idx
    ON conversations(agent_id, updated_at DESC, id DESC);

  CREATE TABLE IF NOT EXISTS conversation_messages (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    turn_id         TEXT NOT NULL,
    ordinal         INTEGER NOT NULL CHECK (ordinal > 0),
    role            TEXT NOT NULL CHECK (role IN ('user','assistant')),
    content         TEXT NOT NULL,
    status          TEXT NOT NULL CHECK (status IN ('accepted','streaming','completed','cancelled','failed','interrupted')),
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    UNIQUE(conversation_id, ordinal),
    UNIQUE(conversation_id, turn_id, role),
    UNIQUE(turn_id, role)
  );

  CREATE INDEX IF NOT EXISTS conversation_messages_page_idx
    ON conversation_messages(conversation_id, ordinal DESC, id DESC);
  CREATE INDEX IF NOT EXISTS stream_events_turn_idx
    ON agent_stream_events(agent_id, conversation_id, msg_id, seq);
`;

export interface SqliteConversationServiceOptions {
  dataDir: string;
  now?: () => string;
  uuid?: () => string;
}

export class SqliteConversationService {
  private readonly db: DatabaseType;
  private readonly now: () => string;
  private readonly uuid: () => string;
  readonly eventLog: EventLogStore;

  constructor(options: SqliteConversationServiceOptions) {
    mkdirSync(options.dataDir, { recursive: true });
    this.db = new Database(join(options.dataDir, 'agent-stream-events.db'));
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.eventLog = new SqliteEventLogStore({ database: this.db });
    this.db.exec(SCHEMA_SQL);
    this.now = options.now ?? (() => new Date().toISOString());
    this.uuid = options.uuid ?? randomUUID;
  }

  close(): void {
    this.eventLog.close();
    this.db.close();
  }
}
