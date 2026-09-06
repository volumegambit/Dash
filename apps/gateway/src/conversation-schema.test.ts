import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database, { type Database as DatabaseType } from 'better-sqlite3';
import { SqliteConversationService } from './conversation-service-sqlite.js';

const CONVERSATION_ID = 'conversation-legacy';

function columns(db: DatabaseType, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((row) => row.name);
}

function createLegacyDatabase(path: string): void {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE conversations (
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

    CREATE TABLE conversation_messages (
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

    CREATE TABLE agent_stream_events (
      agent_id        TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      seq             INTEGER NOT NULL,
      msg_id          TEXT NOT NULL,
      payload         TEXT NOT NULL,
      timestamp       TEXT NOT NULL,
      PRIMARY KEY (agent_id, conversation_id, seq)
    );

    INSERT INTO conversations VALUES (
      '${CONVERSATION_ID}', 'request-legacy', 'agent-legacy', 'Legacy Agent',
      'Legacy conversation', 2, 'idle', NULL, NULL, NULL, 2,
      '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:01.000Z', NULL
    );

    INSERT INTO conversation_messages VALUES
      ('message-user', '${CONVERSATION_ID}', 'turn-legacy', 1, 'user',
       '{"type":"user","text":"Legacy question"}', 'completed',
       '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'),
      ('message-assistant', '${CONVERSATION_ID}', 'turn-legacy', 2, 'assistant',
       '{"type":"assistant","events":[]}', 'completed',
       '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:01.000Z');

    INSERT INTO agent_stream_events VALUES
      ('agent-legacy', '${CONVERSATION_ID}', 1, 'turn-legacy',
       '{"type":"event","event":{"type":"text_delta","text":"Legacy answer"}}',
       '2026-07-01T00:00:00.500Z'),
      ('agent-legacy', '${CONVERSATION_ID}', 2, 'turn-legacy',
       '{"type":"done","outcome":"completed"}', '2026-07-01T00:00:01.000Z');
  `);
  db.close();
}

describe('conversation schema migration', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'conversation-schema-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('hydrates a real legacy database and remains idempotent on reopen', () => {
    const databasePath = join(tmpDir, 'agent-stream-events.db');
    createLegacyDatabase(databasePath);

    let service = new SqliteConversationService({ dataDir: tmpDir });
    let db = (service as unknown as { db: DatabaseType }).db;

    expect(columns(db, 'conversations')).toEqual(
      expect.arrayContaining([
        'v2_last_seq',
        'queue_paused',
        'queue_revision',
        'next_message_ordinal',
      ]),
    );
    expect(columns(db, 'conversation_messages')).toEqual(
      expect.arrayContaining(['run_id', 'segment_index', 'delivery_kind', 'delivery_status']),
    );
    expect(columns(db, 'agent_stream_events')).toContain('segment_turn_id');
    expect(db.prepare('SELECT next_message_ordinal FROM conversations').pluck().get()).toBe(3);
    expect(
      db
        .prepare(
          'SELECT run_id, segment_index, delivery_kind FROM conversation_messages ORDER BY ordinal',
        )
        .all(),
    ).toEqual([
      { run_id: 'turn-legacy', segment_index: 0, delivery_kind: 'normal' },
      { run_id: 'turn-legacy', segment_index: 0, delivery_kind: 'normal' },
    ]);
    expect(
      db.prepare('SELECT segment_turn_id FROM agent_stream_events ORDER BY seq').pluck().all(),
    ).toEqual(['turn-legacy', 'turn-legacy']);
    expect(service.listMessages({ conversationId: CONVERSATION_ID, limit: 10 }).items).toHaveLength(
      2,
    );

    service.close();
    service = new SqliteConversationService({ dataDir: tmpDir });
    db = (service as unknown as { db: DatabaseType }).db;
    expect(db.prepare('SELECT next_message_ordinal FROM conversations').pluck().get()).toBe(3);
    expect(service.listMessages({ conversationId: CONVERSATION_ID, limit: 10 }).items).toHaveLength(
      2,
    );
    service.acceptTurn({
      agentId: 'agent-legacy',
      conversationId: CONVERSATION_ID,
      turnId: 'turn-after-migration',
      text: 'Allocate after the legacy tail',
    });
    expect(
      db.prepare('SELECT ordinal FROM conversation_messages ORDER BY ordinal').pluck().all(),
    ).toEqual([1, 2, 3, 4]);
    expect(db.prepare('SELECT next_message_ordinal FROM conversations').pluck().get()).toBe(5);
    service.close();
  });
});
