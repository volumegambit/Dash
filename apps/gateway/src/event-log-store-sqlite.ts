import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database, { type Database as DatabaseType, type Statement } from 'better-sqlite3';
import type {
  EventLogEntry,
  EventLogPayload,
  EventLogStore,
  InterruptedConversation,
} from './event-log-store.js';

/**
 * SQLite-backed `EventLogStore` adapter. All SQL — schema, prepared
 * statements, PRAGMAs — lives in this file. Any other file in the
 * codebase that needs event-log access imports the interface from
 * `event-log-store.ts` and takes an `EventLogStore` via dependency
 * injection; nothing else in the gateway touches `better-sqlite3`
 * or knows that SQLite is the backend.
 *
 * Storage: one table `agent_stream_events` with a composite primary
 * key on `(agent_id, conversation_id, seq)`. The PK covers both
 * query patterns — `readSince` by conversation, `deleteAgent` by
 * agent — without needing a secondary index.
 *
 * Concurrency: WAL mode so readers don't block writers and vice
 * versa. Within a single Node process, `better-sqlite3`'s sync API
 * plus JavaScript's single-threaded event loop naturally keeps the
 * `MAX(seq)+1` → `INSERT` pair atomic without an explicit
 * transaction. A future multi-process gateway would need to wrap
 * that pair in `BEGIN IMMEDIATE`/`COMMIT` to serialize on SQLite's
 * writer lock across processes; flagged in the `append()` docstring.
 */
interface OwnedSqliteEventLogStoreOptions {
  dataDir: string;
  database?: never;
}

interface InjectedSqliteEventLogStoreOptions {
  database: DatabaseType;
  dataDir?: never;
}

export type SqliteEventLogStoreOptions =
  | OwnedSqliteEventLogStoreOptions
  | InjectedSqliteEventLogStoreOptions;

function ownsDatabase(
  options: SqliteEventLogStoreOptions,
): options is OwnedSqliteEventLogStoreOptions {
  return typeof options.dataDir === 'string';
}

/**
 * Row shape as it comes back from SQLite. snake_case columns,
 * converted to camelCase `EventLogEntry` on read.
 */
interface AgentStreamEventRow {
  agent_id: string;
  conversation_id: string;
  seq: number;
  msg_id: string;
  payload: string;
  timestamp: string;
}

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS agent_stream_events (
    agent_id         TEXT    NOT NULL,
    conversation_id  TEXT    NOT NULL,
    seq              INTEGER NOT NULL,
    msg_id           TEXT    NOT NULL,
    payload          TEXT    NOT NULL,
    timestamp        TEXT    NOT NULL,
    PRIMARY KEY (agent_id, conversation_id, seq)
  )
`;

export class SqliteEventLogStore implements EventLogStore {
  private readonly db: DatabaseType;
  private readonly ownsDatabase: boolean;

  // Prepared statements — parsed once at construction, reused for
  // every call. Measurable throughput win over re-parsing each time.
  private readonly nextSeqStmt: Statement;
  private readonly insertEventStmt: Statement;
  private readonly selectSinceStmt: Statement;
  private readonly listInterruptedStmt: Statement;
  private readonly deleteAgentStmt: Statement;
  private readonly deleteConversationStmt: Statement;

  constructor(options: SqliteEventLogStoreOptions) {
    if (ownsDatabase(options)) {
      this.ownsDatabase = true;
      const dbPath = join(options.dataDir, 'agent-stream-events.db');
      mkdirSync(dirname(dbPath), { recursive: true });
      this.db = new Database(dbPath);
    } else {
      this.ownsDatabase = false;
      this.db = options.database;
    }

    // WAL mode: writers don't block readers, which matters once
    // autonomous agents are producing events in parallel. Per-run
    // durability is eventual (graceful shutdown + WAL checkpoint
    // flush both persist everything; a hard power cut may lose the
    // last few events). That trade-off is acceptable for "recover
    // dropped WebSocket events" — the durability contract is "what
    // the gateway already persisted, we can replay", not "every
    // event survives a kernel panic".
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');

    this.db.prepare(SCHEMA_SQL).run();

    this.nextSeqStmt = this.db.prepare(`
      SELECT COALESCE(MAX(seq), 0) + 1 AS next
      FROM agent_stream_events
      WHERE agent_id = ? AND conversation_id = ?
    `);

    this.insertEventStmt = this.db.prepare(`
      INSERT INTO agent_stream_events
        (agent_id, conversation_id, seq, msg_id, payload, timestamp)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    this.selectSinceStmt = this.db.prepare(`
      SELECT agent_id, conversation_id, seq, msg_id, payload, timestamp
      FROM agent_stream_events
      WHERE agent_id = ? AND conversation_id = ? AND seq > ?
      ORDER BY seq ASC
    `);

    // A conversation is "interrupted" when its newest entry is a
    // non-terminal payload. Rather than json_extract-ing the newest
    // row's type, compare seqs: the max seq of any done/error marker
    // (0 if none) is below MAX(seq) exactly when the tail is a plain
    // event. json_extract needs no index — this runs once per boot.
    this.listInterruptedStmt = this.db.prepare(`
      SELECT
        e.agent_id,
        e.conversation_id,
        (SELECT m.msg_id FROM agent_stream_events m
          WHERE m.agent_id = e.agent_id AND m.conversation_id = e.conversation_id
          ORDER BY m.seq DESC LIMIT 1) AS last_msg_id,
        COALESCE((SELECT MAX(t.seq) FROM agent_stream_events t
          WHERE t.agent_id = e.agent_id AND t.conversation_id = e.conversation_id
            AND json_extract(t.payload, '$.type') IN ('done', 'error')), 0) AS last_terminal_seq
      FROM agent_stream_events e
      GROUP BY e.agent_id, e.conversation_id
      HAVING last_terminal_seq < MAX(e.seq)
    `);

    this.deleteAgentStmt = this.db.prepare('DELETE FROM agent_stream_events WHERE agent_id = ?');

    this.deleteConversationStmt = this.db.prepare(
      'DELETE FROM agent_stream_events WHERE agent_id = ? AND conversation_id = ?',
    );
  }

  /**
   * Append a logged event. Returns the assigned per-conversation
   * `seq`. Single-process atomicity: the `MAX(seq)+1` SELECT and
   * the INSERT both run synchronously without a yield to the event
   * loop, so no other JS task can observe the counter mid-increment.
   * A multi-process gateway would need `BEGIN IMMEDIATE`/`COMMIT`
   * around these two statements to serialize across processes.
   */
  append(agentId: string, conversationId: string, msgId: string, payload: EventLogPayload): number {
    const row = this.nextSeqStmt.get(agentId, conversationId) as { next: number } | undefined;
    const seq = row?.next ?? 1;
    this.insertEventStmt.run(
      agentId,
      conversationId,
      seq,
      msgId,
      JSON.stringify(payload),
      new Date().toISOString(),
    );
    return seq;
  }

  readSince(agentId: string, conversationId: string, sinceSeq: number): EventLogEntry[] {
    const rows = this.selectSinceStmt.all(
      agentId,
      conversationId,
      sinceSeq,
    ) as AgentStreamEventRow[];

    return rows.map((row) => ({
      seq: row.seq,
      msgId: row.msg_id,
      agentId: row.agent_id,
      conversationId: row.conversation_id,
      timestamp: row.timestamp,
      payload: JSON.parse(row.payload) as EventLogPayload,
    }));
  }

  listInterrupted(): InterruptedConversation[] {
    const rows = this.listInterruptedStmt.all() as Array<{
      agent_id: string;
      conversation_id: string;
      last_msg_id: string;
      last_terminal_seq: number;
    }>;
    return rows.map((row) => ({
      agentId: row.agent_id,
      conversationId: row.conversation_id,
      lastMsgId: row.last_msg_id,
      lastTerminalSeq: row.last_terminal_seq,
    }));
  }

  deleteAgent(agentId: string): void {
    this.deleteAgentStmt.run(agentId);
  }

  deleteConversation(agentId: string, conversationId: string): void {
    this.deleteConversationStmt.run(agentId, conversationId);
  }

  close(): void {
    if (this.ownsDatabase) this.db.close();
  }
}
