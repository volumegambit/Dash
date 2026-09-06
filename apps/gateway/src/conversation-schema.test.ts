import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database, { type Database as DatabaseType } from 'better-sqlite3';
import { migrateConversationSchema } from './conversation-schema.js';
import { SqliteConversationService } from './conversation-service-sqlite.js';

const CONVERSATION_ID = 'conversation-legacy';
const OTHER_CONVERSATION_ID = 'conversation-other';

function columns(db: DatabaseType, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((row) => row.name);
}

function legacyMessages(db: DatabaseType): unknown[] {
  return db
    .prepare(`
      SELECT id, conversation_id, turn_id, ordinal, role, content, status, created_at, updated_at
      FROM conversation_messages
      ORDER BY conversation_id, ordinal
    `)
    .all();
}

function createLegacyDatabase(path: string): unknown[] {
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
      uNiQuE ( turn_id , role )
    );

    CREATE INDEX conversation_messages_page_idx
      ON conversation_messages(conversation_id, ordinal DESC, id DESC);

    CREATE TABLE agent_stream_events (
      agent_id        TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      seq             INTEGER NOT NULL,
      msg_id          TEXT NOT NULL,
      payload         TEXT NOT NULL,
      timestamp       TEXT NOT NULL,
      PRIMARY KEY (agent_id, conversation_id, seq)
    );

    INSERT INTO conversations VALUES
      (
        '${CONVERSATION_ID}', 'request-legacy', 'agent-legacy', 'Legacy Agent',
        'Legacy conversation', 2, 'idle', NULL, NULL, NULL, 2,
        '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:01.000Z', NULL
      ),
      (
        '${OTHER_CONVERSATION_ID}', 'request-other', 'agent-legacy', 'Legacy Agent',
        'Other conversation', 1, 'idle', NULL, NULL, NULL, 0,
        '2026-07-01T00:00:02.000Z', '2026-07-01T00:00:02.000Z', NULL
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
  const snapshot = legacyMessages(db);
  db.close();
  return snapshot;
}

describe('conversation schema migration', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'conversation-schema-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('losslessly rebuilds a legacy global turn constraint with scoped uniqueness', () => {
    const databasePath = join(tmpDir, 'agent-stream-events.db');
    const legacySnapshot = createLegacyDatabase(databasePath);

    const service = new SqliteConversationService({ dataDir: tmpDir });
    const db = (service as unknown as { db: DatabaseType }).db;

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
    expect(legacyMessages(db)).toEqual(legacySnapshot);

    const tableSql = db
      .prepare(
        "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'conversation_messages'",
      )
      .pluck()
      .get() as string;
    const normalizedSql = tableSql.toLowerCase().replace(/\s+/gu, '');
    expect(normalizedSql).toContain('unique(conversation_id,turn_id,role)');
    expect(normalizedSql).not.toContain('unique(turn_id,role)');
    expect(
      db
        .prepare(
          "SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = 'conversation_messages_page_idx'",
        )
        .pluck()
        .get(),
    ).toBe(
      'CREATE INDEX conversation_messages_page_idx\n      ON conversation_messages(conversation_id, ordinal DESC, id DESC)',
    );
    expect(db.pragma('foreign_key_list(conversation_messages)')).toEqual([
      expect.objectContaining({
        table: 'conversations',
        from: 'conversation_id',
        to: 'id',
        on_delete: 'CASCADE',
      }),
    ]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    service.close();
  });

  it('allows the same opaque turn ID in two migrated conversations without rebuilding on reopen', () => {
    const databasePath = join(tmpDir, 'agent-stream-events.db');
    createLegacyDatabase(databasePath);

    let service = new SqliteConversationService({ dataDir: tmpDir });
    let db = (service as unknown as { db: DatabaseType }).db;
    const first = service.acceptTurn({
      agentId: 'agent-legacy',
      conversationId: CONVERSATION_ID,
      turnId: 'turn-01',
      text: 'First conversation',
    });
    const second = service.acceptTurn({
      agentId: 'agent-legacy',
      conversationId: OTHER_CONVERSATION_ID,
      turnId: 'turn-01',
      text: 'Second conversation',
    });
    expect(first.created).toBe(true);
    expect(second.created).toBe(true);
    expect(
      db
        .prepare(
          'SELECT ordinal FROM conversation_messages WHERE conversation_id = ? ORDER BY ordinal',
        )
        .pluck()
        .all(CONVERSATION_ID),
    ).toEqual([1, 2, 3, 4]);
    expect(
      db
        .prepare(
          'SELECT ordinal FROM conversation_messages WHERE conversation_id = ? ORDER BY ordinal',
        )
        .pluck()
        .all(OTHER_CONVERSATION_ID),
    ).toEqual([1, 2]);
    const rootPage = db
      .prepare(
        "SELECT rootpage FROM sqlite_schema WHERE type = 'table' AND name = 'conversation_messages'",
      )
      .pluck()
      .get();
    const schemaVersion = db.pragma('schema_version', { simple: true });

    service.close();
    service = new SqliteConversationService({ dataDir: tmpDir });
    db = (service as unknown as { db: DatabaseType }).db;
    expect(
      db
        .prepare(
          "SELECT rootpage FROM sqlite_schema WHERE type = 'table' AND name = 'conversation_messages'",
        )
        .pluck()
        .get(),
    ).toBe(rootPage);
    expect(db.pragma('schema_version', { simple: true })).toBe(schemaVersion);
    expect(
      service.acceptTurn({
        agentId: 'agent-legacy',
        conversationId: CONVERSATION_ID,
        turnId: 'turn-01',
        text: 'Ignored retry',
      }),
    ).toMatchObject({ created: false, userMessage: { id: first.userMessage.id } });
    expect(
      service.acceptTurn({
        agentId: 'agent-legacy',
        conversationId: OTHER_CONVERSATION_ID,
        turnId: 'turn-01',
        text: 'Ignored retry',
      }),
    ).toMatchObject({ created: false, userMessage: { id: second.userMessage.id } });
    expect(
      db
        .prepare('SELECT next_message_ordinal FROM conversations WHERE id = ?')
        .pluck()
        .all(OTHER_CONVERSATION_ID),
    ).toEqual([3]);
    service.close();
  });

  it('checks only rebuilt message foreign keys instead of unrelated legacy violations', () => {
    const databasePath = join(tmpDir, 'agent-stream-events.db');
    createLegacyDatabase(databasePath);
    const db = new Database(databasePath);
    db.pragma('foreign_keys = OFF');
    db.exec(`
      CREATE TABLE unrelated_parents (id TEXT PRIMARY KEY);
      CREATE TABLE unrelated_children (
        id TEXT PRIMARY KEY,
        parent_id TEXT NOT NULL REFERENCES unrelated_parents(id)
      );
      INSERT INTO unrelated_children VALUES ('child-orphan', 'parent-missing');
    `);
    db.pragma('foreign_keys = ON');

    expect(() => migrateConversationSchema(db)).not.toThrow();
    expect(db.pragma('foreign_key_check(conversation_messages)')).toEqual([]);
    expect(db.pragma('foreign_key_check(unrelated_children)')).toHaveLength(1);
    db.close();
  });
});
