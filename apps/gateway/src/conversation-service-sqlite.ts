import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentEvent } from '@dash/agent';
import type {
  ConversationContent,
  ConversationKind,
  ConversationMessage,
  ConversationMessageOrigin,
  ConversationMessagePage,
  ConversationPage,
  ConversationPatchRequest,
  ConversationSummary,
  MobileAgentEvent,
  SubagentInfo,
  SubagentStatus,
} from '@dash/mobile-contract';
import Database, { type Database as DatabaseType } from 'better-sqlite3';
import {
  decodeConversationCursor,
  decodeMessageCursor,
  encodeConversationCursor,
  encodeMessageCursor,
} from './conversation-cursors.js';
import {
  type AcceptTurnInput,
  type AcceptedTurn,
  type ConversationService,
  ConversationServiceError,
  type CreateConversationInput,
  type CreateSubagentConversationInput,
  DEFAULT_CONVERSATION_TITLE,
  DEFAULT_SUBAGENT_LIST_LIMIT,
  type FinishTurnInput,
  type ListConversationsInput,
  type ListMessagesInput,
  MAX_QUEUED_NOTIFICATIONS,
  type PendingNotification,
  type PersistedTurnFrame,
  type SubagentGrant,
  type UpdateSubagentInput,
} from './conversation-service.js';
import { SqliteEventLogStore } from './event-log-store-sqlite.js';
import type { EventLogEntry, EventLogPayload, EventLogStore } from './event-log-store.js';

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

  CREATE TABLE IF NOT EXISTS pending_notifications (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    kind            TEXT NOT NULL CHECK (kind IN ('subagent_finished','subagent_message')),
    payload         TEXT NOT NULL,
    created_at      TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS pending_notifications_queue_idx
    ON pending_notifications(conversation_id, created_at, id);
`;

/**
 * Columns added after the first release. The database already exists in the
 * field, so these are guarded `ALTER TABLE`s rather than a table rewrite:
 * `CREATE TABLE IF NOT EXISTS` is a no-op against an older table shape and
 * would silently leave the new columns missing.
 */
const ADDED_COLUMNS: ReadonlyArray<readonly [table: string, column: string, ddl: string]> = [
  ['conversations', 'kind', "TEXT NOT NULL DEFAULT 'user'"],
  ['conversations', 'parent_conversation_id', 'TEXT'],
  ['conversations', 'parent_turn_id', 'TEXT'],
  ['conversations', 'depth', 'INTEGER NOT NULL DEFAULT 0'],
  ['conversations', 'subagent_type', 'TEXT'],
  ['conversations', 'subagent_name', 'TEXT'],
  ['conversations', 'subagent_status', 'TEXT'],
  ['conversations', 'subagent_meta', 'TEXT'],
  ['conversations', 'subagent_grant', 'TEXT'],
  ['conversation_messages', 'origin', "TEXT NOT NULL DEFAULT 'user'"],
];

/** Indexes that can only be created once {@link ADDED_COLUMNS} are in place. */
const MIGRATED_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS conversations_kind_list_idx
    ON conversations(kind, updated_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS conversations_parent_idx
    ON conversations(parent_conversation_id, created_at, id);
`;

/**
 * Add `column` to `table` when it is absent. Idempotent: re-opening the same
 * file must not re-run the `ALTER`, which SQLite rejects as a duplicate column.
 */
function ensureColumn(db: DatabaseType, table: string, column: string, ddl: string): void {
  const existing = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
  if (existing.some((info) => info.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

export interface SqliteConversationServiceOptions {
  dataDir: string;
  now?: () => string;
  uuid?: () => string;
}

interface ConversationRow {
  id: string;
  create_request_id: string;
  agent_id: string;
  agent_name_snapshot: string;
  title: string;
  revision: number;
  status: ConversationSummary['status'];
  active_turn_id: string | null;
  owning_issue_id: string | null;
  project_id: string | null;
  last_seq: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  kind: ConversationKind;
  parent_conversation_id: string | null;
  parent_turn_id: string | null;
  depth: number;
  subagent_type: string | null;
  subagent_name: string | null;
  subagent_status: SubagentStatus | null;
  subagent_meta: string | null;
  subagent_grant: string | null;
}

/**
 * The part of {@link SubagentInfo} that lives in the `subagent_meta` JSON blob.
 * `type`, `name`, `status` and `depth` are columns so they can be filtered on.
 */
type SubagentMeta = Omit<SubagentInfo, 'type' | 'name' | 'status' | 'depth'>;

interface PendingNotificationRow {
  id: string;
  conversation_id: string;
  kind: PendingNotification['kind'];
  payload: string;
  created_at: string;
}

interface ConversationMessageRow {
  id: string;
  conversation_id: string;
  turn_id: string;
  ordinal: number;
  role: ConversationMessage['role'];
  content: string;
  status: ConversationMessage['status'];
  created_at: string;
  updated_at: string;
  origin: ConversationMessageOrigin;
}

function collapsePreview(text: string): string {
  return [...text.trim().replace(/\s+/gu, ' ')].slice(0, 120).join('');
}

function parseContent(raw: string): ConversationContent {
  return JSON.parse(raw) as ConversationContent;
}

/** Recombine the columnar fields with the `subagent_meta` blob. */
function mapSubagent(row: ConversationRow): SubagentInfo {
  // A child row without a type or a status is corrupt. Defaulting would mint a
  // summary that violates the contract this task just wrote (`type` is
  // `minLength: 1`) or invent a status for a row whose state is unknown.
  if (!row.subagent_type) {
    throw new Error(`Subagent conversation ${row.id} has no subagent_type`);
  }
  if (!row.subagent_status) {
    throw new Error(`Subagent conversation ${row.id} has no subagent_status`);
  }
  const meta = (row.subagent_meta ? JSON.parse(row.subagent_meta) : {}) as Partial<SubagentMeta>;
  return {
    type: row.subagent_type,
    ...(row.subagent_name ? { name: row.subagent_name } : {}),
    status: row.subagent_status,
    description: meta.description ?? '',
    prompt: meta.prompt ?? '',
    model: meta.model ?? '',
    background: meta.background ?? false,
    ...(meta.isolation ? { isolation: meta.isolation } : {}),
    depth: row.depth,
    startedAt: meta.startedAt ?? row.created_at,
    ...(meta.endedAt ? { endedAt: meta.endedAt } : {}),
    ...(meta.usage ? { usage: meta.usage } : {}),
    toolCallCount: meta.toolCallCount ?? 0,
    ...(meta.report !== undefined ? { report: meta.report } : {}),
    oneShot: meta.oneShot ?? false,
    // Only known once the child's backend has been built (an isolated child's
    // worktree path is minted there), so an unset value stays absent rather
    // than defaulting to the parent workspace — which is exactly what
    // isolation exists to deny.
    ...(meta.workspace !== undefined ? { workspace: meta.workspace } : {}),
  };
}

/** Split {@link SubagentInfo} into the JSON blob half, dropping the columns. */
function subagentMeta(info: SubagentInfo): SubagentMeta {
  const { type: _type, name: _name, status: _status, depth: _depth, ...meta } = info;
  return meta;
}

function sanitizeJsonValue(value: unknown): unknown {
  if (value instanceof Error) return value.message;
  if (Array.isArray(value)) return value.map((item) => sanitizeJsonValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, sanitizeJsonValue(item)]),
    );
  }
  return value;
}

function sanitizeAgentEvent(event: AgentEvent): MobileAgentEvent {
  return sanitizeJsonValue(event) as MobileAgentEvent;
}

function isTerminalPayload(payload: EventLogPayload): boolean {
  return payload.type === 'done' || payload.type === 'error';
}

class LateTurnEventError extends Error {}

export class SqliteConversationService implements ConversationService {
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
    for (const [table, column, ddl] of ADDED_COLUMNS) {
      ensureColumn(this.db, table, column, ddl);
    }
    this.db.exec(MIGRATED_INDEX_SQL);
    this.now = options.now ?? (() => new Date().toISOString());
    this.uuid = options.uuid ?? randomUUID;
  }

  private selectConversationRow(id: string): ConversationRow | undefined {
    return this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as
      | ConversationRow
      | undefined;
  }

  private selectByRequestId(requestId: string): ConversationRow | undefined {
    return this.db
      .prepare('SELECT * FROM conversations WHERE create_request_id = ?')
      .get(requestId) as ConversationRow | undefined;
  }

  private lastMessagePreview(conversationId: string): string | null {
    const row = this.db
      .prepare(`
        SELECT content
        FROM conversation_messages
        WHERE conversation_id = ? AND role = 'user'
        ORDER BY ordinal DESC, id DESC
        LIMIT 1
      `)
      .get(conversationId) as { content: string } | undefined;
    if (!row) return null;
    const content = parseContent(row.content);
    return content.type === 'user' ? collapsePreview(content.text) : null;
  }

  private mapStoredMessage(row: ConversationMessageRow): ConversationMessage {
    return {
      id: row.id,
      conversationId: row.conversation_id,
      turnId: row.turn_id,
      ordinal: row.ordinal,
      role: row.role,
      status: row.status,
      content: parseContent(row.content),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      origin: row.origin,
    };
  }

  private selectTurnMessageRows(turnId: string): ConversationMessageRow[] {
    return this.db
      .prepare('SELECT * FROM conversation_messages WHERE turn_id = ? ORDER BY ordinal ASC')
      .all(turnId) as ConversationMessageRow[];
  }

  private findJournalEntry(
    conversation: ConversationRow,
    turnId: string,
    predicate: (payload: EventLogPayload) => boolean,
  ): EventLogEntry | undefined {
    return this.eventLog
      .readSince(conversation.agent_id, conversation.id, 0)
      .filter((entry) => entry.msgId === turnId)
      .findLast((entry) => predicate(entry.payload));
  }

  private assertTurnWritable(conversation: ConversationRow): void {
    if (conversation.status === 'archived') {
      throw new ConversationServiceError(
        'validation_failed',
        'Archived conversations cannot accept turn writes',
        409,
        false,
      );
    }
    if (conversation.status === 'deleted') {
      throw new ConversationServiceError('not_found', 'Conversation was deleted', 410, false);
    }
  }

  private mapConversation(row: ConversationRow): ConversationSummary {
    return {
      id: row.id,
      agentId: row.agent_id,
      agentName: row.agent_name_snapshot,
      title: row.title,
      revision: row.revision,
      status: row.status,
      activeTurnId: row.active_turn_id,
      owningIssueId: row.owning_issue_id,
      projectId: row.project_id,
      lastSeq: row.last_seq,
      lastMessagePreview: this.lastMessagePreview(row.id),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.deleted_at ? { deletedAt: row.deleted_at } : {}),
      kind: row.kind,
      ...(row.parent_conversation_id ? { parentConversationId: row.parent_conversation_id } : {}),
      ...(row.parent_turn_id ? { parentTurnId: row.parent_turn_id } : {}),
      ...(row.kind === 'subagent' ? { subagent: mapSubagent(row) } : {}),
    };
  }

  private requireConversationRow(id: string, includeDeleted = false): ConversationRow {
    const row = this.selectConversationRow(id);
    if (!row || (row.deleted_at && !includeDeleted)) {
      throw new ConversationServiceError(
        'not_found',
        `Conversation ${id} was not found`,
        404,
        false,
      );
    }
    return row;
  }

  private assertRevision(current: ConversationRow, expectedRevision: number): void {
    if (current.revision === expectedRevision) return;
    throw new ConversationServiceError(
      'revision_conflict',
      `Conversation revision ${expectedRevision} is stale`,
      409,
      false,
      { current: this.mapConversation(current) },
    );
  }

  create(input: CreateConversationInput): ConversationSummary {
    return this.db.transaction((value: CreateConversationInput) => {
      const existing = this.selectByRequestId(value.requestId);
      if (existing) return this.mapConversation(existing);

      const id = this.uuid();
      const timestamp = this.now();
      try {
        this.db
          .prepare(`
            INSERT INTO conversations (
              id, create_request_id, agent_id, agent_name_snapshot, title,
              revision, status, active_turn_id, owning_issue_id, project_id,
              last_seq, created_at, updated_at, deleted_at
            ) VALUES (
              @id, @createRequestId, @agentId, @agentName, @title,
              1, 'idle', NULL, @owningIssueId, @projectId,
              0, @createdAt, @updatedAt, NULL
            )
          `)
          .run({
            id,
            createRequestId: value.requestId,
            agentId: value.agentId,
            agentName: value.agentName,
            title: value.title?.trim() || DEFAULT_CONVERSATION_TITLE,
            owningIssueId: value.owningIssueId ?? null,
            projectId: value.projectId ?? null,
            createdAt: timestamp,
            updatedAt: timestamp,
          });
      } catch (error) {
        const canonical = this.selectByRequestId(value.requestId);
        if (canonical) return this.mapConversation(canonical);
        throw error;
      }
      return this.mapConversation(this.requireConversationRow(id, true));
    })(input);
  }

  get(id: string, options: { includeDeleted?: boolean } = {}): ConversationSummary | null {
    const row = this.selectConversationRow(id);
    if (!row || (row.deleted_at && !options.includeDeleted)) return null;
    return this.mapConversation(row);
  }

  list(input: ListConversationsInput): ConversationPage {
    if (!Number.isInteger(input.limit) || input.limit <= 0) {
      throw new ConversationServiceError('validation_failed', 'Invalid page limit', 400, false);
    }
    const cursor = input.cursor ? decodeConversationCursor(input.cursor) : undefined;
    const rows = this.db
      .prepare(`
        SELECT * FROM conversations
        WHERE deleted_at IS NULL
          AND kind = :kind
          AND (:agentId IS NULL OR agent_id = :agentId)
          AND (
            :parentConversationId IS NULL
            OR parent_conversation_id = :parentConversationId
          )
          AND (
            :cursorUpdatedAt IS NULL
            OR updated_at < :cursorUpdatedAt
            OR (updated_at = :cursorUpdatedAt AND id < :cursorId)
          )
        ORDER BY updated_at DESC, id DESC
        LIMIT :fetchLimit
      `)
      .all({
        // Children stay hidden unless the caller names their kind (see
        // ListConversationsInput.kind).
        kind: input.kind ?? 'user',
        agentId: input.agentId ?? null,
        parentConversationId: input.parentConversationId ?? null,
        cursorUpdatedAt: cursor?.updatedAt ?? null,
        cursorId: cursor?.id ?? null,
        fetchLimit: input.limit + 1,
      }) as ConversationRow[];
    const hasMore = rows.length > input.limit;
    const pageRows = rows.slice(0, input.limit);
    const boundary = hasMore ? pageRows.at(-1) : undefined;
    return {
      items: pageRows.map((row) => this.mapConversation(row)),
      nextCursor: boundary
        ? encodeConversationCursor({ updatedAt: boundary.updated_at, id: boundary.id })
        : null,
    };
  }

  update(
    id: string,
    expectedRevision: number,
    patch: ConversationPatchRequest,
  ): ConversationSummary {
    const hasPatch = ['title', 'owningIssueId', 'projectId'].some(
      (key) =>
        Object.hasOwn(patch, key) && patch[key as keyof ConversationPatchRequest] !== undefined,
    );
    if (!hasPatch || (patch.title !== undefined && patch.title.trim().length === 0)) {
      throw new ConversationServiceError(
        'validation_failed',
        'Conversation patch is empty or invalid',
        400,
        false,
      );
    }

    return this.db.transaction(() => {
      const current = this.requireConversationRow(id, true);
      if (current.status === 'deleted') {
        throw new ConversationServiceError('not_found', 'Conversation was deleted', 410, false);
      }
      if (current.status === 'archived') {
        throw new ConversationServiceError(
          'validation_failed',
          'Archived conversations cannot be updated',
          409,
          false,
        );
      }
      this.assertRevision(current, expectedRevision);
      this.db
        .prepare(`
          UPDATE conversations
          SET title = @title,
              owning_issue_id = @owningIssueId,
              project_id = @projectId,
              revision = revision + 1,
              updated_at = @updatedAt
          WHERE id = @id
        `)
        .run({
          id,
          title: patch.title !== undefined ? patch.title.trim() : current.title,
          owningIssueId:
            patch.owningIssueId !== undefined ? patch.owningIssueId : current.owning_issue_id,
          projectId: patch.projectId !== undefined ? patch.projectId : current.project_id,
          updatedAt: this.now(),
        });
      return this.mapConversation(this.requireConversationRow(id, true));
    })();
  }

  delete(id: string, expectedRevision: number): ConversationSummary {
    return this.db.transaction(() => {
      const current = this.requireConversationRow(id, true);
      if (current.status === 'deleted') {
        throw new ConversationServiceError('not_found', 'Conversation was deleted', 410, false);
      }
      if (current.status === 'archived') {
        throw new ConversationServiceError(
          'validation_failed',
          'Archived conversations cannot be deleted',
          409,
          false,
        );
      }
      if (current.active_turn_id !== null) {
        throw new ConversationServiceError(
          'conversation_busy',
          'Conversation has an active turn',
          409,
          false,
          { activeTurnId: current.active_turn_id },
        );
      }
      this.assertRevision(current, expectedRevision);
      const timestamp = this.now();
      this.purgeConversationContent(current.agent_id, id);
      const tombstoned = this.db
        .prepare(`
          UPDATE conversations
          SET status = 'deleted', active_turn_id = NULL, revision = revision + 1,
              updated_at = @now, deleted_at = @now
          WHERE id = @id AND active_turn_id IS NULL
        `)
        .run({ id, now: timestamp });
      if (tombstoned.changes !== 1) {
        const fresh = this.requireConversationRow(id, true);
        if (fresh.active_turn_id !== null) {
          throw new ConversationServiceError(
            'conversation_busy',
            'Conversation has an active turn',
            409,
            false,
            { activeTurnId: fresh.active_turn_id },
          );
        }
        throw new Error(`Failed to tombstone conversation ${id}`);
      }
      this.tombstoneDescendants(id, timestamp);
      return this.mapConversation(this.requireConversationRow(id, true));
    })();
  }

  /**
   * Drop everything a tombstone must not keep: the transcript, the event log
   * and the notification queue. The conversation row survives as a tombstone,
   * so the `pending_notifications` FK cascade never fires — hence the explicit
   * delete.
   */
  private purgeConversationContent(agentId: string, conversationId: string): void {
    this.db
      .prepare('DELETE FROM conversation_messages WHERE conversation_id = ?')
      .run(conversationId);
    this.db
      .prepare('DELETE FROM pending_notifications WHERE conversation_id = ?')
      .run(conversationId);
    this.eventLog.deleteConversation(agentId, conversationId);
  }

  /**
   * Deleting a conversation deletes its whole subtree. Children carry no FK to
   * their parent, so nothing else would remove them, and a surviving child is a
   * privacy leak: `subagent.prompt` can quote the parent context the user just
   * deleted and `GET /conversations/:childId` has no `kind` gate. Children nest,
   * so this walks the tree. A child holding an active turn is tombstoned
   * anyway — the user's delete outranks a runaway child.
   */
  private tombstoneDescendants(rootId: string, timestamp: string): void {
    const selectChildren = this.db.prepare(
      'SELECT * FROM conversations WHERE parent_conversation_id = ? AND deleted_at IS NULL',
    );
    const tombstone = this.db.prepare(`
      UPDATE conversations
      SET status = 'deleted', active_turn_id = NULL, revision = revision + 1,
          updated_at = @now, deleted_at = @now
      WHERE id = @id
    `);
    const queue = [rootId];
    const seen = new Set<string>([rootId]);
    while (queue.length > 0) {
      const parentId = queue.shift() as string;
      for (const child of selectChildren.all(parentId) as ConversationRow[]) {
        // Defensive: a cycle would otherwise spin forever.
        if (seen.has(child.id)) continue;
        seen.add(child.id);
        queue.push(child.id);
        this.purgeConversationContent(child.agent_id, child.id);
        tombstone.run({ id: child.id, now: timestamp });
      }
    }
  }

  listMessages(input: ListMessagesInput): ConversationMessagePage {
    if (!Number.isInteger(input.limit) || input.limit <= 0) {
      throw new ConversationServiceError('validation_failed', 'Invalid page limit', 400, false);
    }
    const conversation = this.requireConversationRow(input.conversationId);
    const before = input.before ? decodeMessageCursor(input.before) : undefined;
    const rows = this.db
      .prepare(`
        SELECT * FROM (
          SELECT * FROM conversation_messages
          WHERE conversation_id = :conversationId
            AND (
              :beforeOrdinal IS NULL
              OR ordinal < :beforeOrdinal
              OR (ordinal = :beforeOrdinal AND id < :beforeId)
            )
          ORDER BY ordinal DESC, id DESC
          LIMIT :fetchLimit
        )
        ORDER BY ordinal ASC, id ASC
      `)
      .all({
        conversationId: input.conversationId,
        beforeOrdinal: before?.ordinal ?? null,
        beforeId: before?.id ?? null,
        fetchLimit: input.limit + 1,
      }) as ConversationMessageRow[];
    const hasMore = rows.length > input.limit;
    const pageRows = hasMore ? rows.slice(1) : rows;
    const boundary = hasMore ? pageRows[0] : undefined;
    const allEvents = this.eventLog.readSince(conversation.agent_id, conversation.id, 0);
    const items = pageRows.map((row): ConversationMessage => {
      let content = parseContent(row.content);
      if (row.role === 'assistant') {
        const events: MobileAgentEvent[] = allEvents
          .filter((entry) => entry.msgId === row.turn_id && entry.payload.type === 'event')
          .map((entry) => (entry.payload as { type: 'event'; event: MobileAgentEvent }).event);
        content = { type: 'assistant', events };
      }
      return {
        id: row.id,
        conversationId: row.conversation_id,
        turnId: row.turn_id,
        ordinal: row.ordinal,
        role: row.role,
        status: row.status,
        content,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        origin: row.origin,
      };
    });
    return {
      items,
      nextCursor: boundary
        ? encodeMessageCursor({ ordinal: boundary.ordinal, id: boundary.id })
        : null,
      throughSeq: conversation.last_seq,
    };
  }

  acceptTurn(input: AcceptTurnInput): AcceptedTurn {
    return this.db.transaction((value: AcceptTurnInput): AcceptedTurn => {
      const current = this.requireConversationRow(value.conversationId);
      this.assertTurnWritable(current);
      if (current.agent_id !== value.agentId) {
        throw new ConversationServiceError(
          'not_found',
          `Conversation ${value.conversationId} does not belong to agent ${value.agentId}`,
          404,
          false,
        );
      }

      const existingRows = this.selectTurnMessageRows(value.turnId);
      if (existingRows.length > 0) {
        const user = existingRows.find((row) => row.role === 'user');
        const assistant = existingRows.find((row) => row.role === 'assistant');
        if (
          existingRows.length !== 2 ||
          !user ||
          !assistant ||
          user.conversation_id !== value.conversationId ||
          assistant.conversation_id !== value.conversationId
        ) {
          throw new ConversationServiceError(
            'validation_failed',
            `Turn ${value.turnId} is already owned by another conversation`,
            409,
            false,
          );
        }
        const accepted = this.findJournalEntry(
          current,
          value.turnId,
          (payload) => payload.type === 'accepted',
        );
        if (!accepted || accepted.payload.type !== 'accepted') {
          throw new ConversationServiceError(
            'validation_failed',
            `Turn ${value.turnId} is missing its accepted journal entry`,
            409,
            false,
          );
        }
        return {
          conversation: this.mapConversation(current),
          userMessage: this.mapStoredMessage(user),
          assistantMessage: this.mapStoredMessage(assistant),
          seq: accepted.seq,
          revision: accepted.payload.revision,
          created: false,
          firstUserMessage: user.ordinal === 1,
        };
      }

      if (current.active_turn_id !== null) {
        throw new ConversationServiceError(
          'conversation_busy',
          'Conversation has an active turn',
          409,
          false,
          { activeTurnId: current.active_turn_id },
        );
      }

      const ordinalRow = this.db
        .prepare(`
          SELECT COALESCE(MAX(ordinal), 0) + 1 AS next
          FROM conversation_messages
          WHERE conversation_id = ?
        `)
        .get(value.conversationId) as { next: number };
      const userOrdinal = ordinalRow.next;
      const userMessageId = this.uuid();
      const assistantMessageId = this.uuid();
      const timestamp = this.now();
      const userContent: ConversationContent = {
        type: 'user',
        text: value.text,
        ...(value.images !== undefined ? { images: value.images } : {}),
      };
      const assistantContent: ConversationContent = { type: 'assistant', events: [] };
      const turnOrigin: ConversationMessageOrigin = value.origin ?? 'user';
      const insertMessage = this.db.prepare(`
        INSERT INTO conversation_messages (
          id, conversation_id, turn_id, ordinal, role, content, status,
          origin, created_at, updated_at
        ) VALUES (
          @id, @conversationId, @turnId, @ordinal, @role, @content, @status,
          @origin, @now, @now
        )
      `);
      insertMessage.run({
        id: userMessageId,
        conversationId: value.conversationId,
        turnId: value.turnId,
        ordinal: userOrdinal,
        role: 'user',
        content: JSON.stringify(userContent),
        status: 'accepted',
        origin: turnOrigin,
        now: timestamp,
      });
      insertMessage.run({
        id: assistantMessageId,
        conversationId: value.conversationId,
        turnId: value.turnId,
        ordinal: userOrdinal + 1,
        role: 'assistant',
        content: JSON.stringify(assistantContent),
        status: 'streaming',
        // `origin` describes the turn, not the row. listMessages pages by
        // ordinal, so a page boundary can split a turn's two adjacent rows —
        // an assistant row that did not carry the origin would be unrecoverable
        // (its sibling is on another page) and a client filtering out
        // notification turns would drop the question but keep the answer.
        origin: turnOrigin,
        now: timestamp,
      });

      const nextRevision = current.revision + 1;
      const seq = this.eventLog.append(value.agentId, value.conversationId, value.turnId, {
        type: 'accepted',
        userMessageId,
        assistantMessageId,
        revision: nextRevision,
      });
      const acquired = this.db
        .prepare(`
          UPDATE conversations
          SET status = 'running', active_turn_id = @turnId, revision = @revision,
              last_seq = @lastSeq, updated_at = @now
          WHERE id = @id AND active_turn_id IS NULL AND deleted_at IS NULL
            AND status NOT IN ('archived', 'deleted')
        `)
        .run({
          id: value.conversationId,
          turnId: value.turnId,
          revision: nextRevision,
          lastSeq: seq,
          now: timestamp,
        });
      if (acquired.changes !== 1) {
        const fresh = this.requireConversationRow(value.conversationId, true);
        if (fresh.active_turn_id !== null) {
          throw new ConversationServiceError(
            'conversation_busy',
            'Conversation has an active turn',
            409,
            false,
            { activeTurnId: fresh.active_turn_id },
          );
        }
        this.assertTurnWritable(fresh);
        throw new Error(`Failed to acquire conversation lease for ${value.conversationId}`);
      }

      const rows = this.selectTurnMessageRows(value.turnId);
      const user = rows.find((row) => row.role === 'user') as ConversationMessageRow;
      const assistant = rows.find((row) => row.role === 'assistant') as ConversationMessageRow;
      return {
        conversation: this.mapConversation(this.requireConversationRow(value.conversationId)),
        userMessage: this.mapStoredMessage(user),
        assistantMessage: this.mapStoredMessage(assistant),
        seq,
        revision: nextRevision,
        created: true,
        firstUserMessage: userOrdinal === 1,
      };
    })(input);
  }

  appendTurnEvent(
    conversationId: string,
    turnId: string,
    event: AgentEvent,
  ): PersistedTurnFrame | null {
    try {
      return this.db.transaction((): PersistedTurnFrame | null => {
        const current = this.requireConversationRow(conversationId, true);
        if (
          current.status === 'archived' ||
          current.status === 'deleted' ||
          current.active_turn_id !== turnId
        ) {
          return null;
        }
        const payload: EventLogPayload = {
          type: 'event',
          event: sanitizeAgentEvent(event),
        };
        const seq = this.eventLog.append(current.agent_id, conversationId, turnId, payload);
        const updated = this.db
          .prepare(`
            UPDATE conversations
            SET last_seq = @lastSeq
            WHERE id = @id AND active_turn_id = @turnId AND status = 'running'
          `)
          .run({ id: conversationId, turnId, lastSeq: seq });
        if (updated.changes !== 1) throw new LateTurnEventError();
        return {
          conversation: this.mapConversation(this.requireConversationRow(conversationId)),
          seq,
          payload,
        };
      })();
    } catch (error) {
      if (error instanceof LateTurnEventError) return null;
      throw error;
    }
  }

  finishTurn(input: FinishTurnInput): PersistedTurnFrame {
    return this.db.transaction((value: FinishTurnInput): PersistedTurnFrame => {
      const current = this.requireConversationRow(value.conversationId, true);
      const existingTerminal = this.findJournalEntry(current, value.turnId, isTerminalPayload);
      if (existingTerminal && isTerminalPayload(existingTerminal.payload)) {
        return {
          conversation: this.mapConversation(current),
          seq: existingTerminal.seq,
          payload: existingTerminal.payload,
        };
      }

      this.assertTurnWritable(current);
      if (current.active_turn_id !== value.turnId) {
        if (current.active_turn_id !== null) {
          throw new ConversationServiceError(
            'conversation_busy',
            'Conversation has an active turn',
            409,
            false,
            { activeTurnId: current.active_turn_id },
          );
        }
        throw new ConversationServiceError(
          'validation_failed',
          `Turn ${value.turnId} is not active`,
          409,
          false,
        );
      }

      const payload: EventLogPayload =
        value.outcome === 'failed'
          ? {
              type: 'error',
              error: value.error,
              ...(value.code !== undefined ? { code: value.code } : {}),
              retryable: value.retryable,
            }
          : { type: 'done', outcome: value.outcome };
      const assistantStatus: ConversationMessage['status'] =
        value.outcome === 'failed' ? 'failed' : value.outcome;
      const timestamp = this.now();
      const seq = this.eventLog.append(
        current.agent_id,
        value.conversationId,
        value.turnId,
        payload,
      );
      const assistantUpdate = this.db
        .prepare(`
          UPDATE conversation_messages
          SET status = @status, updated_at = @now
          WHERE conversation_id = @conversationId AND turn_id = @turnId AND role = 'assistant'
        `)
        .run({
          conversationId: value.conversationId,
          turnId: value.turnId,
          status: assistantStatus,
          now: timestamp,
        });
      if (assistantUpdate.changes !== 1) {
        throw new Error(`Assistant message for turn ${value.turnId} was not found`);
      }
      const conversationUpdate = this.db
        .prepare(`
          UPDATE conversations
          SET status = 'idle', active_turn_id = NULL, revision = revision + 1,
              last_seq = @lastSeq, updated_at = @now
          WHERE id = @id AND active_turn_id = @turnId AND status = 'running'
        `)
        .run({
          id: value.conversationId,
          turnId: value.turnId,
          lastSeq: seq,
          now: timestamp,
        });
      if (conversationUpdate.changes !== 1) {
        throw new Error(`Failed to release conversation lease for turn ${value.turnId}`);
      }
      return {
        conversation: this.mapConversation(this.requireConversationRow(value.conversationId)),
        seq,
        payload,
      };
    })(input);
  }

  /**
   * Create a child conversation. Idempotent on `id` so a spawn retry (or a
   * replayed recovery step) returns the existing row instead of colliding.
   */
  createSubagent(input: CreateSubagentConversationInput): ConversationSummary {
    return this.db.transaction((value: CreateSubagentConversationInput) => {
      const existing = this.selectConversationRow(value.id);
      if (existing) {
        if (existing.kind !== 'subagent') {
          throw new ConversationServiceError(
            'validation_failed',
            `Conversation ${value.id} already exists and is not a subagent conversation`,
            409,
            false,
          );
        }
        // A tombstone survives forever, so the idempotence branch would
        // otherwise report a deleted child as a successful spawn and the first
        // acceptTurn would fail with not_found.
        if (existing.deleted_at) {
          throw new ConversationServiceError(
            'not_found',
            `Conversation ${value.id} was deleted`,
            410,
            false,
          );
        }
        return this.mapConversation(existing);
      }

      const parent = this.requireConversationRow(value.parentConversationId);
      const timestamp = this.now();
      this.db
        .prepare(`
          INSERT INTO conversations (
            id, create_request_id, agent_id, agent_name_snapshot, title,
            revision, status, active_turn_id, owning_issue_id, project_id,
            last_seq, created_at, updated_at, deleted_at,
            kind, parent_conversation_id, parent_turn_id, depth,
            subagent_type, subagent_name, subagent_status, subagent_meta
          ) VALUES (
            @id, @createRequestId, @agentId, @agentName, @title,
            1, 'idle', NULL, @owningIssueId, @projectId,
            0, @createdAt, @updatedAt, NULL,
            'subagent', @parentConversationId, @parentTurnId, @depth,
            @subagentType, @subagentName, @subagentStatus, @subagentMeta
          )
        `)
        .run({
          id: value.id,
          createRequestId: `subagent:${value.id}`,
          agentId: value.agentId,
          agentName: value.agentName,
          title: value.title.trim() || DEFAULT_CONVERSATION_TITLE,
          // Children inherit their parent's linkage so project/issue filters
          // keep working once children become addressable.
          owningIssueId: parent.owning_issue_id,
          projectId: parent.project_id,
          createdAt: timestamp,
          updatedAt: timestamp,
          parentConversationId: value.parentConversationId,
          parentTurnId: value.parentTurnId,
          depth: value.subagent.depth,
          subagentType: value.subagent.type,
          subagentName: value.subagent.name ?? null,
          subagentStatus: value.subagent.status,
          subagentMeta: JSON.stringify(subagentMeta(value.subagent)),
        });
      return this.mapConversation(this.requireConversationRow(value.id));
    })(input);
  }

  putSubagentGrant(id: string, grant: SubagentGrant | undefined): void {
    // No revision bump and no `updated_at` touch: the grant is gateway-internal
    // (it is not in `ConversationSummary`), so a client's optimistic-concurrency
    // token must not move because a child was re-prepared.
    this.db
      .prepare('UPDATE conversations SET subagent_grant = @grant WHERE id = @id')
      .run({ id, grant: grant ? JSON.stringify(grant) : null });
  }

  getSubagentGrant(id: string): SubagentGrant | undefined {
    const row = this.selectConversationRow(id);
    if (!row?.subagent_grant) return undefined;
    return JSON.parse(row.subagent_grant) as SubagentGrant;
  }

  updateSubagent(id: string, patch: UpdateSubagentInput): ConversationSummary {
    return this.db.transaction(() => {
      const current = this.requireConversationRow(id);
      if (current.kind !== 'subagent') {
        throw new ConversationServiceError(
          'validation_failed',
          `Conversation ${id} is not a subagent conversation`,
          409,
          false,
        );
      }
      const merged: SubagentInfo = {
        ...mapSubagent(current),
        ...(patch.info ?? {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
      };
      this.db
        .prepare(`
          UPDATE conversations
          SET subagent_type = @subagentType,
              subagent_name = @subagentName,
              subagent_status = @subagentStatus,
              subagent_meta = @subagentMeta,
              depth = @depth,
              revision = revision + 1,
              updated_at = @now
          WHERE id = @id
        `)
        .run({
          id,
          subagentType: merged.type,
          subagentName: merged.name ?? null,
          subagentStatus: merged.status,
          subagentMeta: JSON.stringify(subagentMeta(merged)),
          depth: merged.depth,
          now: this.now(),
        });
      return this.mapConversation(this.requireConversationRow(id));
    })();
  }

  listSubagents(
    parentConversationId: string,
    limit: number = DEFAULT_SUBAGENT_LIST_LIMIT,
  ): ConversationSummary[] {
    // Ordered DESC under the LIMIT so the page keeps the NEWEST children, then
    // reversed back to the oldest-first order every caller reads. Taking the
    // oldest `limit` instead would hide exactly the children still worth
    // addressing.
    const rows = this.db
      .prepare(`
        SELECT * FROM conversations
        WHERE kind = 'subagent' AND parent_conversation_id = ? AND deleted_at IS NULL
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `)
      .all(parentConversationId, Math.max(0, limit)) as ConversationRow[];
    return rows.reverse().map((row) => this.mapConversation(row));
  }

  listInterruptedSubagents(): ConversationSummary[] {
    const rows = this.db
      .prepare(`
        SELECT * FROM conversations
        WHERE kind = 'subagent' AND subagent_status = 'interrupted' AND deleted_at IS NULL
        ORDER BY created_at ASC, id ASC
      `)
      .all() as ConversationRow[];
    return rows.map((row) => this.mapConversation(row));
  }

  enqueueNotification(
    notification: Omit<PendingNotification, 'id' | 'createdAt'>,
  ): PendingNotification {
    return this.db.transaction(() => {
      this.requireConversationRow(notification.conversationId);
      const queued = this.db
        .prepare('SELECT COUNT(*) AS total FROM pending_notifications WHERE conversation_id = ?')
        .get(notification.conversationId) as { total: number };
      if (queued.total >= MAX_QUEUED_NOTIFICATIONS) {
        throw new ConversationServiceError(
          'validation_failed',
          `Notification queue full for conversation ${notification.conversationId}`,
          409,
          false,
          { conversationId: notification.conversationId, queued: queued.total },
        );
      }
      const id = this.uuid();
      const createdAt = this.now();
      const payload = JSON.stringify(sanitizeJsonValue(notification.payload));
      this.db
        .prepare(`
          INSERT INTO pending_notifications (id, conversation_id, kind, payload, created_at)
          VALUES (@id, @conversationId, @kind, @payload, @createdAt)
        `)
        .run({
          id,
          conversationId: notification.conversationId,
          kind: notification.kind,
          payload,
          createdAt,
        });
      return {
        id,
        conversationId: notification.conversationId,
        kind: notification.kind,
        // Round-trip so the caller sees exactly what a later drain will yield.
        payload: JSON.parse(payload) as Record<string, unknown>,
        createdAt,
      };
    })();
  }

  drainNotifications(conversationId: string): PendingNotification[] {
    return this.db.transaction(() => {
      // rowid keeps insertion order stable when several notifications share a
      // timestamp (they routinely do — a fan-out finishes in one tick).
      const rows = this.db
        .prepare(`
          SELECT * FROM pending_notifications
          WHERE conversation_id = ?
          ORDER BY created_at ASC, rowid ASC
        `)
        .all(conversationId) as PendingNotificationRow[];
      if (rows.length === 0) return [];
      this.db
        .prepare('DELETE FROM pending_notifications WHERE conversation_id = ?')
        .run(conversationId);
      return rows.map((row) => ({
        id: row.id,
        conversationId: row.conversation_id,
        kind: row.kind,
        payload: JSON.parse(row.payload) as Record<string, unknown>,
        createdAt: row.created_at,
      }));
    })();
  }

  trySetAutoTitle(id: string, title: string): ConversationSummary | null {
    const normalized = title.trim();
    if (normalized.length === 0) return null;
    return this.db.transaction(() => {
      const changed = this.db
        .prepare(`
          UPDATE conversations
          SET title = @title, revision = revision + 1, updated_at = @now
          WHERE id = @id AND title = @defaultTitle AND deleted_at IS NULL
            AND status NOT IN ('archived', 'deleted')
        `)
        .run({
          id,
          title: normalized,
          defaultTitle: DEFAULT_CONVERSATION_TITLE,
          now: this.now(),
        });
      if (changed.changes !== 1) return null;
      return this.mapConversation(this.requireConversationRow(id));
    })();
  }

  archiveAgentConversations(agentId: string): ConversationSummary[] {
    return this.db.transaction(() => {
      const active = this.db
        .prepare(`
          SELECT * FROM conversations
          WHERE agent_id = ? AND active_turn_id IS NOT NULL AND deleted_at IS NULL
          ORDER BY updated_at ASC, id ASC
          LIMIT 1
        `)
        .get(agentId) as ConversationRow | undefined;
      if (active !== undefined) {
        throw new ConversationServiceError(
          'conversation_busy',
          'Conversation has an active turn',
          409,
          false,
          { activeTurnId: active.active_turn_id },
        );
      }
      const timestamp = this.now();
      const changed = this.db
        .prepare(`
          UPDATE conversations
          SET status = 'archived', active_turn_id = NULL,
              revision = revision + 1, updated_at = @now
          WHERE agent_id = @agentId AND deleted_at IS NULL
        `)
        .run({ agentId, now: timestamp });
      if (changed.changes === 0) return [];
      const rows = this.db
        .prepare(`
          SELECT * FROM conversations
          WHERE agent_id = ? AND deleted_at IS NULL
          ORDER BY updated_at DESC, id DESC
        `)
        .all(agentId) as ConversationRow[];
      return rows.map((row) => this.mapConversation(row));
    })();
  }

  recoverInterruptedTurns(): {
    conversationsInterrupted: number;
    terminalsAppended: number;
  } {
    return this.db.transaction(() => {
      const rows = this.db
        .prepare(`
          SELECT * FROM conversations
          WHERE status = 'running' AND active_turn_id IS NOT NULL AND deleted_at IS NULL
          ORDER BY updated_at ASC, id ASC
        `)
        .all() as ConversationRow[];
      let conversationsInterrupted = 0;
      let terminalsAppended = 0;
      for (const row of rows) {
        const turnId = row.active_turn_id as string;
        const turnEntries = this.eventLog
          .readSince(row.agent_id, row.id, 0)
          .filter((entry) => entry.msgId === turnId);
        const lastEntry = turnEntries.at(-1);
        let terminalSeq: number;
        if (lastEntry && isTerminalPayload(lastEntry.payload)) {
          terminalSeq = lastEntry.seq;
        } else {
          terminalSeq = this.eventLog.append(row.agent_id, row.id, turnId, {
            type: 'error',
            error: 'Gateway restarted while this turn was in progress.',
            code: 'gateway_offline',
            retryable: true,
          });
          terminalsAppended++;
        }
        const timestamp = this.now();
        this.db
          .prepare(`
            UPDATE conversation_messages
            SET status = 'interrupted', updated_at = @now
            WHERE conversation_id = @conversationId AND turn_id = @turnId
              AND role = 'assistant'
          `)
          .run({ conversationId: row.id, turnId, now: timestamp });
        const changed = this.db
          .prepare(`
            UPDATE conversations
            SET status = 'interrupted', active_turn_id = NULL, revision = revision + 1,
                last_seq = CASE WHEN last_seq < @lastSeq THEN @lastSeq ELSE last_seq END,
                updated_at = @now
            WHERE id = @id AND status = 'running' AND active_turn_id = @turnId
          `)
          .run({ id: row.id, turnId, lastSeq: terminalSeq, now: timestamp });
        if (changed.changes === 1) conversationsInterrupted++;
      }
      return { conversationsInterrupted, terminalsAppended };
    })();
  }

  close(): void {
    this.eventLog.close();
    this.db.close();
  }
}
