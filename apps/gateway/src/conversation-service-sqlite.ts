import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ConversationContent,
  ConversationMessage,
  ConversationMessagePage,
  ConversationPage,
  ConversationPatchRequest,
  ConversationSummary,
  MobileAgentEvent,
} from '@dash/mobile-contract';
import Database, { type Database as DatabaseType } from 'better-sqlite3';
import {
  decodeConversationCursor,
  decodeMessageCursor,
  encodeConversationCursor,
  encodeMessageCursor,
} from './conversation-cursors.js';
import {
  ConversationServiceError,
  type CreateConversationInput,
  DEFAULT_CONVERSATION_TITLE,
  type ListConversationsInput,
  type ListMessagesInput,
} from './conversation-service.js';
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
}

function collapsePreview(text: string): string {
  return [...text.trim().replace(/\s+/gu, ' ')].slice(0, 120).join('');
}

function parseContent(raw: string): ConversationContent {
  return JSON.parse(raw) as ConversationContent;
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
          AND (:agentId IS NULL OR agent_id = :agentId)
          AND (
            :cursorUpdatedAt IS NULL
            OR updated_at < :cursorUpdatedAt
            OR (updated_at = :cursorUpdatedAt AND id < :cursorId)
          )
        ORDER BY updated_at DESC, id DESC
        LIMIT :fetchLimit
      `)
      .all({
        agentId: input.agentId ?? null,
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
      this.db.prepare('DELETE FROM conversation_messages WHERE conversation_id = ?').run(id);
      this.eventLog.deleteConversation(current.agent_id, id);
      this.db
        .prepare(`
          UPDATE conversations
          SET status = 'deleted', active_turn_id = NULL, revision = revision + 1,
              updated_at = @now, deleted_at = @now
          WHERE id = @id AND active_turn_id IS NULL
        `)
        .run({ id, now: timestamp });
      return this.mapConversation(this.requireConversationRow(id, true));
    })();
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

  close(): void {
    this.eventLog.close();
    this.db.close();
  }
}
