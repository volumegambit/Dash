import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentEvent } from '@dash/agent';
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
  type AcceptTurnInput,
  type AcceptedTurn,
  type ConversationService,
  ConversationServiceError,
  type CreateConversationInput,
  DEFAULT_CONVERSATION_TITLE,
  type FinishTurnInput,
  type ListConversationsInput,
  type ListMessagesInput,
  type PersistedTurnFrame,
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
      this.db.prepare('DELETE FROM conversation_messages WHERE conversation_id = ?').run(id);
      this.eventLog.deleteConversation(current.agent_id, id);
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
      const insertMessage = this.db.prepare(`
        INSERT INTO conversation_messages (
          id, conversation_id, turn_id, ordinal, role, content, status, created_at, updated_at
        ) VALUES (
          @id, @conversationId, @turnId, @ordinal, @role, @content, @status, @now, @now
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
