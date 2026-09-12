import type { Database as DatabaseType } from 'better-sqlite3';

interface TableInfoRow {
  name: string;
}

interface SqliteSchemaRow {
  sql: string | null;
}

interface CountRow {
  count: number;
}

function tableColumns(db: DatabaseType, table: string): Set<string> {
  return new Set((db.pragma(`table_info(${table})`) as TableInfoRow[]).map((row) => row.name));
}

function addMissingColumns(
  db: DatabaseType,
  table: string,
  definitions: ReadonlyArray<readonly [name: string, sql: string]>,
): void {
  const columns = tableColumns(db, table);
  for (const [name, sql] of definitions) {
    if (columns.has(name)) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${sql}`);
    columns.add(name);
  }
}

function hasLegacyGlobalTurnConstraint(db: DatabaseType): boolean {
  const row = db
    .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?")
    .get('conversation_messages') as SqliteSchemaRow | undefined;
  const normalizedSql = row?.sql
    ?.toLowerCase()
    .replace(/\s+/gu, '')
    .replace(/["`\[\]]/gu, '');
  return normalizedSql?.includes('unique(turn_id,role)') ?? false;
}

function rebuildConversationMessages(db: DatabaseType): void {
  const duplicate = db
    .prepare(`
      SELECT conversation_id, turn_id, role
      FROM conversation_messages
      GROUP BY conversation_id, turn_id, role
      HAVING COUNT(*) > 1
      LIMIT 1
    `)
    .get();
  if (duplicate) {
    throw new Error('Cannot migrate duplicate conversation-scoped turn messages');
  }

  const sourceCount = (
    db.prepare('SELECT COUNT(*) AS count FROM conversation_messages').get() as CountRow
  ).count;
  db.exec(`
    CREATE TABLE conversation_messages_v2_migration (
      id              TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      turn_id         TEXT NOT NULL,
      run_id          TEXT,
      segment_index   INTEGER NOT NULL DEFAULT 0,
      ordinal         INTEGER NOT NULL CHECK (ordinal > 0),
      role            TEXT NOT NULL CHECK (role IN ('user','assistant')),
      content         TEXT NOT NULL,
      status          TEXT NOT NULL CHECK (status IN ('accepted','streaming','completed','cancelled','failed','interrupted')),
      delivery_kind   TEXT NOT NULL DEFAULT 'normal',
      delivery_status TEXT,
      origin          TEXT NOT NULL DEFAULT 'user',
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL,
      UNIQUE(conversation_id, ordinal),
      UNIQUE(conversation_id, turn_id, role)
    );

    INSERT INTO conversation_messages_v2_migration (
      id, conversation_id, turn_id, run_id, segment_index, ordinal, role, content, status,
      delivery_kind, delivery_status, origin, created_at, updated_at
    )
    SELECT
      id, conversation_id, turn_id, run_id, segment_index, ordinal, role, content, status,
      delivery_kind, delivery_status, origin, created_at, updated_at
    FROM conversation_messages;
  `);
  const replacementCount = (
    db.prepare('SELECT COUNT(*) AS count FROM conversation_messages_v2_migration').get() as CountRow
  ).count;
  if (replacementCount !== sourceCount) {
    throw new Error(
      `Conversation message migration copied ${replacementCount} of ${sourceCount} rows`,
    );
  }

  db.exec(`
    DROP TABLE conversation_messages;
    ALTER TABLE conversation_messages_v2_migration RENAME TO conversation_messages;
    CREATE INDEX conversation_messages_page_idx
      ON conversation_messages(conversation_id, ordinal DESC, id DESC);
  `);
}

const V2_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS conversation_v2_events (
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL,
    v2_seq INTEGER NOT NULL CHECK (v2_seq > 0),
    payload TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    PRIMARY KEY (conversation_id, v2_seq)
  );

  CREATE TABLE IF NOT EXISTS conversation_pending_inputs (
    input_id TEXT PRIMARY KEY,
    enqueue_command_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    agent_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('steer','follow_up')),
    target_turn_id TEXT,
    text TEXT NOT NULL,
    images_json TEXT,
    payload_bytes INTEGER NOT NULL CHECK (payload_bytes >= 0),
    state TEXT NOT NULL CHECK (state IN ('queued','delivering','delivered','removed','failed')),
    revision INTEGER NOT NULL CHECK (revision >= 1),
    enqueue_order INTEGER NOT NULL,
    reserved_run_id TEXT NOT NULL,
    reserved_segment_turn_id TEXT NOT NULL,
    reserved_user_message_id TEXT NOT NULL,
    reserved_assistant_message_id TEXT NOT NULL,
    reserved_user_ordinal INTEGER,
    reserved_assistant_ordinal INTEGER,
    segment_index INTEGER NOT NULL,
    failure_code TEXT,
    failure_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    delivered_at TEXT,
    CHECK (
      (kind = 'steer' AND target_turn_id IS NOT NULL
        AND reserved_user_ordinal IS NOT NULL AND reserved_assistant_ordinal IS NOT NULL)
      OR
      (kind = 'follow_up'
        AND reserved_user_ordinal IS NULL AND reserved_assistant_ordinal IS NULL)
    ),
    UNIQUE (conversation_id, enqueue_order)
  );

  CREATE INDEX IF NOT EXISTS pending_inputs_queue_idx
    ON conversation_pending_inputs(conversation_id, state, kind, enqueue_order);

  CREATE TABLE IF NOT EXISTS conversation_command_results (
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    command_id TEXT NOT NULL,
    operation TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL,
    outcome_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (conversation_id, command_id)
  );
`;

/** Add the v2 storage shape to fresh or legacy v1 conversation databases. */
export function migrateConversationSchema(db: DatabaseType): void {
  db.transaction(() => {
    addMissingColumns(db, 'conversations', [
      ['v2_last_seq', 'INTEGER NOT NULL DEFAULT 0 CHECK (v2_last_seq >= 0)'],
      ['queue_paused', 'INTEGER NOT NULL DEFAULT 0 CHECK (queue_paused IN (0, 1))'],
      ['queue_revision', 'INTEGER NOT NULL DEFAULT 0 CHECK (queue_revision >= 0)'],
      ['next_message_ordinal', 'INTEGER NOT NULL DEFAULT 1 CHECK (next_message_ordinal >= 1)'],
    ]);
    addMissingColumns(db, 'conversation_messages', [
      ['run_id', 'TEXT'],
      ['segment_index', 'INTEGER NOT NULL DEFAULT 0'],
      ['delivery_kind', "TEXT NOT NULL DEFAULT 'normal'"],
      ['delivery_status', 'TEXT'],
    ]);
    addMissingColumns(db, 'agent_stream_events', [['segment_turn_id', 'TEXT']]);

    db.exec(`
      UPDATE conversation_messages SET run_id = turn_id WHERE run_id IS NULL;
      UPDATE conversation_messages SET segment_index = 0 WHERE segment_index IS NULL;
      UPDATE conversation_messages SET delivery_kind = 'normal' WHERE delivery_kind IS NULL;
      UPDATE agent_stream_events SET segment_turn_id = msg_id WHERE segment_turn_id IS NULL;
      UPDATE conversations
      SET next_message_ordinal = MAX(
        next_message_ordinal,
        COALESCE((
          SELECT MAX(ordinal) + 1
          FROM conversation_messages
          WHERE conversation_id = conversations.id
        ), 1)
      );
    `);

    if (hasLegacyGlobalTurnConstraint(db)) rebuildConversationMessages(db);

    db.exec(V2_SCHEMA_SQL);
    const foreignKeyViolations = db.pragma('foreign_key_check(conversation_messages)') as unknown[];
    if (foreignKeyViolations.length > 0) {
      throw new Error('Conversation message migration left foreign-key violations');
    }
  })();
}
