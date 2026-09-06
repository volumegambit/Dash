import { createHash, randomUUID } from 'node:crypto';
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
import type {
  MobileV2ControlFrame,
  MobileV2ConversationBootstrap,
  MobileV2PendingInput,
  MobileV2SequencedFrame,
} from '@dash/mobile-contract-v2';
import Database, { type Database as DatabaseType } from 'better-sqlite3';
import {
  mapConversationV1,
  mapConversationV2,
  mapMessageV1,
  mapMessageV2,
} from './conversation-contract-mappers.js';
import {
  decodeConversationCursor,
  decodeMessageCursor,
  encodeConversationCursor,
  encodeMessageCursor,
} from './conversation-cursors.js';
import type {
  AcceptRunInput,
  AcceptedRun,
  AppendRunEventInput,
  ClaimedFollowUp,
  CommandMutationResult,
  DeliverSteerInput,
  DeliveredInput,
  DeliveredSteerContext,
  EditFollowUpCommand,
  EnqueueInputCommand,
  FinishRunInput,
  FinishRunResult,
  MobileV2SequencedPayload,
  PersistedInputTransition,
  PersistedQueueTransition,
  PersistedRunFrames,
  RemoveFollowUpCommand,
  ResumeFollowUpsCommand,
  StoredCommandOutcome,
  StoredConversation,
  StoredConversationMessage,
  StoredPendingInput,
  TerminalizeSteersInput,
  V2RecoveryResult,
  V2ReplayResult,
} from './conversation-domain.js';
import { migrateConversationSchema } from './conversation-schema.js';
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
  MAX_PENDING_INPUTS_PER_KIND,
  MAX_PENDING_INPUT_BYTES,
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

  CREATE TABLE IF NOT EXISTS agent_stream_events (
    agent_id        TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    seq             INTEGER NOT NULL,
    msg_id          TEXT NOT NULL,
    payload         TEXT NOT NULL,
    timestamp       TEXT NOT NULL,
    PRIMARY KEY (agent_id, conversation_id, seq)
  );
`;

const POST_MIGRATION_SCHEMA_SQL = `
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
  v2_last_seq: number;
  queue_paused: number;
  queue_revision: number;
  next_message_ordinal: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

interface ConversationMessageRow {
  id: string;
  conversation_id: string;
  turn_id: string;
  run_id: string | null;
  segment_index: number;
  ordinal: number;
  role: ConversationMessage['role'];
  content: string;
  status: ConversationMessage['status'];
  delivery_kind: StoredConversationMessage['deliveryKind'];
  delivery_status: StoredConversationMessage['deliveryStatus'] | null;
  created_at: string;
  updated_at: string;
}

interface PendingInputRow {
  input_id: string;
  enqueue_command_id: string;
  conversation_id: string;
  agent_id: string;
  channel_id: string;
  kind: 'steer' | 'follow_up';
  target_turn_id: string | null;
  text: string;
  images_json: string | null;
  payload_bytes: number;
  state: 'queued' | 'delivering' | 'delivered' | 'removed' | 'failed';
  revision: number;
  enqueue_order: number;
  reserved_run_id: string;
  reserved_segment_turn_id: string;
  reserved_user_message_id: string;
  reserved_assistant_message_id: string;
  reserved_user_ordinal: number | null;
  reserved_assistant_ordinal: number | null;
  segment_index: number;
  failure_code: import('@dash/mobile-contract').MobileApiErrorCode | null;
  failure_message: string | null;
  created_at: string;
  updated_at: string;
  delivered_at: string | null;
}

interface CommandResultRow {
  operation: string;
  request_fingerprint: string;
  outcome_json: string;
}

type CommandRejectedFrame = Extract<MobileV2ControlFrame, { type: 'command_rejected' }>;

type CommandOperation =
  | 'enqueue_input'
  | 'edit_follow_up'
  | 'remove_follow_up'
  | 'resume_follow_ups';

function collapsePreview(text: string): string {
  return [...text.trim().replace(/\s+/gu, ' ')].slice(0, 120).join('');
}

function parseContent(raw: string): ConversationContent {
  return JSON.parse(raw) as ConversationContent;
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sortJsonValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => [key, sortJsonValue(item)]),
    );
  }
  return value;
}

function commandFingerprint(operation: CommandOperation, input: object): string {
  const canonical = JSON.stringify(sortJsonValue({ operation, input }));
  return createHash('sha256').update(canonical).digest('hex');
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
    this.db.exec(SCHEMA_SQL);
    migrateConversationSchema(this.db);
    this.db.exec(POST_MIGRATION_SCHEMA_SQL);
    this.eventLog = new SqliteEventLogStore({ database: this.db });
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

  private reserveMessageOrdinals(conversationId: string, count: number): number {
    const row = this.db
      .prepare(`
        UPDATE conversations
        SET next_message_ordinal = next_message_ordinal + @count
        WHERE id = @conversationId
        RETURNING next_message_ordinal - @count AS first_ordinal
      `)
      .get({ conversationId, count }) as { first_ordinal: number } | undefined;
    if (!row) throw new Error(`Conversation ${conversationId} was not found`);
    return row.first_ordinal;
  }

  private pendingFollowUpCount(conversationId: string): number {
    const row = this.db
      .prepare(`
        SELECT COUNT(*) AS count
        FROM conversation_pending_inputs
        WHERE conversation_id = ? AND kind = 'follow_up' AND state IN ('queued', 'delivering')
      `)
      .get(conversationId) as { count: number };
    return row.count;
  }

  private mapStoredMessage(row: ConversationMessageRow): StoredConversationMessage {
    return {
      id: row.id,
      conversationId: row.conversation_id,
      turnId: row.turn_id,
      runId: row.run_id ?? row.turn_id,
      segmentIndex: row.segment_index,
      ordinal: row.ordinal,
      role: row.role,
      status: row.status,
      deliveryKind: row.delivery_kind,
      ...(row.delivery_status !== null ? { deliveryStatus: row.delivery_status } : {}),
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

  private mapStoredConversation(row: ConversationRow): StoredConversation {
    return {
      id: row.id,
      createRequestId: row.create_request_id,
      agentId: row.agent_id,
      agentName: row.agent_name_snapshot,
      title: row.title,
      revision: row.revision,
      status: row.status,
      activeRunId: row.active_turn_id,
      owningIssueId: row.owning_issue_id,
      projectId: row.project_id,
      lastSeq: row.last_seq,
      v2LastSeq: row.v2_last_seq,
      queuePaused: row.queue_paused === 1,
      queueRevision: row.queue_revision,
      nextMessageOrdinal: row.next_message_ordinal,
      pendingFollowUpCount: this.pendingFollowUpCount(row.id),
      lastMessagePreview: this.lastMessagePreview(row.id),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.deleted_at ? { deletedAt: row.deleted_at } : {}),
    };
  }

  private mapConversation(row: ConversationRow): ConversationSummary {
    return mapConversationV1(this.mapStoredConversation(row));
  }

  private appendV2(
    conversation: ConversationRow,
    payload: MobileV2SequencedPayload,
  ): MobileV2SequencedFrame {
    const { v2Seq: _ignoredCursor, ...persistedPayload } = payload as MobileV2SequencedPayload & {
      v2Seq?: unknown;
    };
    const advanced = this.db
      .prepare(`
        UPDATE conversations
        SET v2_last_seq = v2_last_seq + 1
        WHERE id = @conversationId
        RETURNING v2_last_seq
      `)
      .get({ conversationId: conversation.id }) as { v2_last_seq: number } | undefined;
    if (!advanced) {
      throw new Error(`Failed to advance v2 journal for conversation ${conversation.id}`);
    }

    this.db
      .prepare(`
        INSERT INTO conversation_v2_events (
          conversation_id, agent_id, v2_seq, payload, timestamp
        ) VALUES (
          @conversationId, @agentId, @v2Seq, @payload, @timestamp
        )
      `)
      .run({
        conversationId: conversation.id,
        agentId: conversation.agent_id,
        v2Seq: advanced.v2_last_seq,
        payload: JSON.stringify(persistedPayload),
        timestamp: this.now(),
      });
    return { ...persistedPayload, v2Seq: advanced.v2_last_seq } as MobileV2SequencedFrame;
  }

  private readV2Rows(conversationId: string, sinceV2Seq: number): MobileV2SequencedFrame[] {
    const rows = this.db
      .prepare(`
        SELECT v2_seq, payload
        FROM conversation_v2_events
        WHERE conversation_id = ? AND v2_seq > ?
        ORDER BY v2_seq ASC
      `)
      .all(conversationId, sinceV2Seq) as Array<{ v2_seq: number; payload: string }>;
    return rows.map((row) => ({
      ...(JSON.parse(row.payload) as MobileV2SequencedPayload),
      v2Seq: row.v2_seq,
    })) as MobileV2SequencedFrame[];
  }

  private readV2Sequences(
    conversationId: string,
    v2Seqs: readonly number[],
  ): MobileV2SequencedFrame[] {
    const select = this.db.prepare(`
      SELECT payload
      FROM conversation_v2_events
      WHERE conversation_id = ? AND v2_seq = ?
    `);
    return v2Seqs.map((v2Seq) => {
      const row = select.get(conversationId, v2Seq) as { payload: string } | undefined;
      if (!row) {
        throw new Error(
          `Command result references missing v2 sequence ${v2Seq} for ${conversationId}`,
        );
      }
      return {
        ...(JSON.parse(row.payload) as MobileV2SequencedPayload),
        v2Seq,
      } as MobileV2SequencedFrame;
    });
  }

  private selectPendingInput(inputId: string): PendingInputRow | undefined {
    return this.db
      .prepare('SELECT * FROM conversation_pending_inputs WHERE input_id = ?')
      .get(inputId) as PendingInputRow | undefined;
  }

  private mapPendingInput(row: PendingInputRow): MobileV2PendingInput {
    return {
      inputId: row.input_id,
      kind: row.kind,
      ...(row.target_turn_id !== null ? { targetTurnId: row.target_turn_id } : {}),
      text: row.text,
      ...(row.images_json !== null
        ? { images: JSON.parse(row.images_json) as MobileV2PendingInput['images'] }
        : {}),
      state: row.state,
      revision: row.revision,
      enqueueOrder: row.enqueue_order,
      runId: row.reserved_run_id,
      segmentTurnId: row.reserved_segment_turn_id,
      userMessageId: row.reserved_user_message_id,
      assistantMessageId: row.reserved_assistant_message_id,
      ...(row.failure_code !== null ? { failureCode: row.failure_code } : {}),
      ...(row.failure_message !== null ? { failureMessage: row.failure_message } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.delivered_at !== null ? { deliveredAt: row.delivered_at } : {}),
    };
  }

  private pendingInputStats(conversationId: string): {
    steerCount: number;
    followUpCount: number;
    payloadBytes: number;
  } {
    const row = this.db
      .prepare(`
        SELECT
          SUM(CASE WHEN kind = 'steer' THEN 1 ELSE 0 END) AS steer_count,
          SUM(CASE WHEN kind = 'follow_up' THEN 1 ELSE 0 END) AS follow_up_count,
          COALESCE(SUM(payload_bytes), 0) AS payload_bytes
        FROM conversation_pending_inputs
        WHERE conversation_id = ? AND state IN ('queued', 'delivering')
      `)
      .get(conversationId) as {
      steer_count: number | null;
      follow_up_count: number | null;
      payload_bytes: number;
    };
    return {
      steerCount: row.steer_count ?? 0,
      followUpCount: row.follow_up_count ?? 0,
      payloadBytes: row.payload_bytes,
    };
  }

  private nextEnqueueOrder(conversationId: string): number {
    return this.db
      .prepare(
        `SELECT COALESCE(MAX(enqueue_order), 0) + 1
         FROM conversation_pending_inputs
         WHERE conversation_id = ?`,
      )
      .pluck()
      .get(conversationId) as number;
  }

  private nextSegmentIndex(conversationId: string, runId: string): number {
    return this.db
      .prepare(
        `SELECT COALESCE(MAX(segment_index), 0) + 1
         FROM (
           SELECT segment_index
           FROM conversation_messages
           WHERE conversation_id = @conversationId AND run_id = @runId
           UNION ALL
           SELECT segment_index
           FROM conversation_pending_inputs
           WHERE conversation_id = @conversationId AND reserved_run_id = @runId
             AND kind = 'steer' AND state = 'queued'
         )`,
      )
      .pluck()
      .get({ conversationId, runId }) as number;
  }

  private mapStoredPendingInput(row: PendingInputRow): StoredPendingInput {
    return {
      inputId: row.input_id,
      enqueueCommandId: row.enqueue_command_id,
      conversationId: row.conversation_id,
      agentId: row.agent_id,
      channelId: row.channel_id,
      kind: row.kind,
      targetTurnId: row.target_turn_id,
      text: row.text,
      ...(row.images_json !== null
        ? { images: JSON.parse(row.images_json) as StoredPendingInput['images'] }
        : {}),
      payloadBytes: row.payload_bytes,
      state: row.state,
      revision: row.revision,
      enqueueOrder: row.enqueue_order,
      reservedRunId: row.reserved_run_id,
      reservedSegmentTurnId: row.reserved_segment_turn_id,
      reservedUserMessageId: row.reserved_user_message_id,
      reservedAssistantMessageId: row.reserved_assistant_message_id,
      reservedUserOrdinal: row.reserved_user_ordinal,
      reservedAssistantOrdinal: row.reserved_assistant_ordinal,
      segmentIndex: row.segment_index,
      ...(row.failure_code !== null ? { failureCode: row.failure_code } : {}),
      ...(row.failure_message !== null ? { failureMessage: row.failure_message } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.delivered_at !== null ? { deliveredAt: row.delivered_at } : {}),
    };
  }

  private advanceQueueMutation(
    conversationId: string,
    queuePaused: boolean | undefined = undefined,
  ): ConversationRow {
    const advanced = this.db
      .prepare(`
        UPDATE conversations
        SET revision = revision + 1,
            queue_revision = queue_revision + 1,
            queue_paused = COALESCE(@queuePaused, queue_paused),
            updated_at = @now
        WHERE id = @conversationId
        RETURNING *
      `)
      .get({
        conversationId,
        queuePaused: queuePaused === undefined ? null : queuePaused ? 1 : 0,
        now: this.now(),
      }) as ConversationRow | undefined;
    if (!advanced) throw new Error(`Conversation ${conversationId} was not found`);
    return advanced;
  }

  private updateLastSeq(conversationId: string, seq: number): void {
    const changed = this.db
      .prepare(`
        UPDATE conversations
        SET last_seq = CASE WHEN last_seq < @seq THEN @seq ELSE last_seq END
        WHERE id = @conversationId
      `)
      .run({ conversationId, seq });
    if (changed.changes !== 1) {
      throw new Error(`Conversation ${conversationId} was not found while updating its journal`);
    }
  }

  private appendAcceptedJournals(
    conversation: ConversationRow,
    runId: string,
    segmentTurnId: string,
    userMessageId: string,
    assistantMessageId: string,
    revision: number,
  ): {
    v1Seq: number;
    v1Payload: AcceptedRun['v1Payload'];
    v2Frame: AcceptedRun['v2Frame'];
  } {
    const v1Payload: AcceptedRun['v1Payload'] = {
      type: 'accepted',
      userMessageId,
      assistantMessageId,
      revision,
    };
    const v1Seq = this.eventLog.append(
      conversation.agent_id,
      conversation.id,
      runId,
      v1Payload,
      segmentTurnId,
    );
    this.updateLastSeq(conversation.id, v1Seq);
    const v2Frame = this.appendV2(conversation, {
      type: 'accepted',
      id: runId,
      conversationId: conversation.id,
      runId,
      segmentTurnId,
      userMessageId,
      assistantMessageId,
      revision,
    }) as AcceptedRun['v2Frame'];
    return { v1Seq, v1Payload, v2Frame };
  }

  private appendEventJournals(
    conversation: ConversationRow,
    runId: string,
    segmentTurnId: string,
    event: AgentEvent,
  ): PersistedRunFrames {
    const payload: EventLogPayload = { type: 'event', event: sanitizeAgentEvent(event) };
    const v1Seq = this.eventLog.append(
      conversation.agent_id,
      conversation.id,
      runId,
      payload,
      segmentTurnId,
    );
    this.updateLastSeq(conversation.id, v1Seq);
    const v2Frame = this.appendV2(conversation, {
      type: 'event',
      id: runId,
      conversationId: conversation.id,
      runId,
      segmentTurnId,
      event: payload.event,
    });
    return {
      conversation: this.mapStoredConversation(this.requireConversationRow(conversation.id)),
      v1Seq,
      v1Payload: payload,
      v2Frame,
    };
  }

  private selectMessageById(id: string): ConversationMessageRow {
    const row = this.db.prepare('SELECT * FROM conversation_messages WHERE id = ?').get(id) as
      | ConversationMessageRow
      | undefined;
    if (!row) throw new Error(`Conversation message ${id} was not found`);
    return row;
  }

  private claimNextFollowUpInTransaction(conversationId: string): ClaimedFollowUp | null {
    const current = this.requireConversationRow(conversationId);
    if (
      current.active_turn_id !== null ||
      current.queue_paused === 1 ||
      current.status === 'archived' ||
      current.status === 'deleted'
    ) {
      return null;
    }
    const pending = this.db
      .prepare(`
        SELECT *
        FROM conversation_pending_inputs
        WHERE conversation_id = ? AND kind = 'follow_up' AND state = 'queued'
        ORDER BY enqueue_order ASC
        LIMIT 1
      `)
      .get(conversationId) as PendingInputRow | undefined;
    if (!pending) return null;

    const delivering = this.db
      .prepare(`
        UPDATE conversation_pending_inputs
        SET state = 'delivering', updated_at = @now
        WHERE input_id = @inputId AND conversation_id = @conversationId
          AND kind = 'follow_up' AND state = 'queued'
      `)
      .run({ inputId: pending.input_id, conversationId, now: this.now() });
    if (delivering.changes !== 1) {
      throw new Error(`Failed to claim Follow Up ${pending.input_id}`);
    }

    const userOrdinal = this.reserveMessageOrdinals(conversationId, 2);
    const timestamp = this.now();
    const userContent: ConversationContent = {
      type: 'user',
      text: pending.text,
      ...(pending.images_json !== null
        ? { images: JSON.parse(pending.images_json) as StoredPendingInput['images'] }
        : {}),
    };
    const insertMessage = this.db.prepare(`
      INSERT INTO conversation_messages (
        id, conversation_id, turn_id, run_id, segment_index, ordinal, role, content, status,
        delivery_kind, delivery_status, created_at, updated_at
      ) VALUES (
        @id, @conversationId, @turnId, @runId, 0, @ordinal, @role, @content, @status,
        'follow_up', NULL, @now, @now
      )
    `);
    insertMessage.run({
      id: pending.reserved_user_message_id,
      conversationId,
      turnId: pending.reserved_segment_turn_id,
      runId: pending.reserved_run_id,
      ordinal: userOrdinal,
      role: 'user',
      content: JSON.stringify(userContent),
      status: 'accepted',
      now: timestamp,
    });
    insertMessage.run({
      id: pending.reserved_assistant_message_id,
      conversationId,
      turnId: pending.reserved_segment_turn_id,
      runId: pending.reserved_run_id,
      ordinal: userOrdinal + 1,
      role: 'assistant',
      content: JSON.stringify({ type: 'assistant', events: [] }),
      status: 'streaming',
      now: timestamp,
    });
    const inputChanged = this.db
      .prepare(`
        UPDATE conversation_pending_inputs
        SET state = 'delivered', revision = revision + 1,
            delivered_at = @now, updated_at = @now
        WHERE input_id = @inputId AND conversation_id = @conversationId AND state = 'delivering'
      `)
      .run({
        inputId: pending.input_id,
        conversationId,
        now: timestamp,
      });
    if (inputChanged.changes !== 1) {
      throw new Error(`Failed to deliver Follow Up ${pending.input_id}`);
    }

    const advanced = this.advanceQueueMutation(conversationId);
    const lease = this.db
      .prepare(`
        UPDATE conversations
        SET status = 'running', active_turn_id = @runId, updated_at = @now
        WHERE id = @conversationId AND active_turn_id IS NULL AND queue_paused = 0
          AND deleted_at IS NULL AND status NOT IN ('archived', 'deleted')
      `)
      .run({ conversationId, runId: pending.reserved_run_id, now: timestamp });
    if (lease.changes !== 1) {
      throw new Error(`Failed to acquire promoted run lease ${pending.reserved_run_id}`);
    }
    const deliveredRow = this.selectPendingInput(pending.input_id);
    if (!deliveredRow) throw new Error(`Delivered Follow Up ${pending.input_id} disappeared`);
    const deliveryFrame = this.appendV2(advanced, {
      type: 'input_delivered',
      id: pending.enqueue_command_id,
      conversationId,
      queueRevision: advanced.queue_revision,
      input: this.mapPendingInput(deliveredRow),
      runId: pending.reserved_run_id,
      segmentTurnId: pending.reserved_segment_turn_id,
      userMessageId: pending.reserved_user_message_id,
      assistantMessageId: pending.reserved_assistant_message_id,
    }) as PersistedInputTransition['frame'];
    const accepted = this.appendAcceptedJournals(
      advanced,
      pending.reserved_run_id,
      pending.reserved_segment_turn_id,
      pending.reserved_user_message_id,
      pending.reserved_assistant_message_id,
      advanced.revision,
    );
    const conversation = this.mapStoredConversation(this.requireConversationRow(conversationId));
    const storedInput = this.mapStoredPendingInput(deliveredRow);
    return {
      transition: { conversation, input: storedInput, frame: deliveryFrame },
      run: {
        conversation,
        runId: pending.reserved_run_id,
        segmentTurnId: pending.reserved_segment_turn_id,
        channelId: pending.channel_id,
        text: pending.text,
        ...(pending.images_json !== null
          ? { images: JSON.parse(pending.images_json) as AcceptedRun['images'] }
          : {}),
        userMessage: this.mapStoredMessage(
          this.selectMessageById(pending.reserved_user_message_id),
        ),
        assistantMessage: this.mapStoredMessage(
          this.selectMessageById(pending.reserved_assistant_message_id),
        ),
        v1Seq: accepted.v1Seq,
        v1Payload: accepted.v1Payload,
        v2Frame: accepted.v2Frame,
        created: true,
        firstUserMessage: userOrdinal === 1,
        sourceInputId: pending.input_id,
      },
    };
  }

  private terminalizeSteersNotDeliveredInTransaction(
    input: TerminalizeSteersInput,
  ): PersistedInputTransition[] {
    const current = this.requireConversationRow(input.conversationId, true);
    const transitions: PersistedInputTransition[] = [];
    for (const inputId of input.inputIds) {
      const pending = this.selectPendingInput(inputId);
      if (
        !pending ||
        pending.conversation_id !== current.id ||
        pending.kind !== 'steer' ||
        pending.reserved_run_id !== input.runId ||
        pending.state !== 'queued'
      ) {
        continue;
      }
      const timestamp = this.now();
      const changed = this.db
        .prepare(`
          UPDATE conversation_pending_inputs
          SET state = 'failed', revision = revision + 1,
              failure_code = @code, failure_message = @error, updated_at = @now
          WHERE input_id = @inputId AND conversation_id = @conversationId
            AND kind = 'steer' AND state = 'queued'
        `)
        .run({
          inputId,
          conversationId: current.id,
          code: input.code,
          error: input.error,
          now: timestamp,
        });
      if (changed.changes !== 1) throw new Error(`Failed to terminalize Steer ${inputId}`);
      const messageChanged = this.db
        .prepare(`
          UPDATE conversation_messages
          SET status = 'failed', delivery_status = 'not_delivered', updated_at = @now
          WHERE id = @messageId AND conversation_id = @conversationId
            AND role = 'user' AND delivery_kind = 'steer' AND delivery_status = 'pending'
        `)
        .run({
          messageId: pending.reserved_user_message_id,
          conversationId: current.id,
          now: timestamp,
        });
      if (messageChanged.changes !== 1) {
        throw new Error(`Failed to mark Steer message ${pending.reserved_user_message_id}`);
      }
      const advanced = this.advanceQueueMutation(current.id);
      const failed = this.selectPendingInput(inputId);
      if (!failed) throw new Error(`Terminalized Steer ${inputId} disappeared`);
      const frame = this.appendV2(advanced, {
        type: 'input_failed',
        id: pending.enqueue_command_id,
        conversationId: current.id,
        queueRevision: advanced.queue_revision,
        input: this.mapPendingInput(failed),
      }) as PersistedInputTransition['frame'];
      transitions.push({
        conversation: this.mapStoredConversation(this.requireConversationRow(current.id, true)),
        input: this.mapStoredPendingInput(failed),
        frame,
      });
    }
    return transitions;
  }

  private replayCommandResult(
    conversationId: string,
    commandId: string,
    fingerprint: string,
  ): CommandMutationResult | null {
    const row = this.db
      .prepare(
        `SELECT operation, request_fingerprint, outcome_json
         FROM conversation_command_results
         WHERE conversation_id = ? AND command_id = ?`,
      )
      .get(conversationId, commandId) as CommandResultRow | undefined;
    if (!row) return null;
    if (row.request_fingerprint !== fingerprint) {
      return {
        replayed: false,
        frames: [
          {
            type: 'command_rejected',
            id: commandId,
            conversationId,
            code: 'validation_failed',
            error: 'Command ID was already used for a different request',
            retryable: false,
          },
        ],
      };
    }
    const outcome = JSON.parse(row.outcome_json) as StoredCommandOutcome;
    return {
      replayed: true,
      frames:
        outcome.kind === 'sequenced'
          ? this.readV2Sequences(conversationId, outcome.v2Seqs)
          : [outcome.frame],
    };
  }

  private storeCommandOutcome(
    conversationId: string,
    commandId: string,
    operation: CommandOperation,
    fingerprint: string,
    outcome: StoredCommandOutcome,
  ): void {
    this.db
      .prepare(`
        INSERT INTO conversation_command_results (
          conversation_id, command_id, operation, request_fingerprint, outcome_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(conversationId, commandId, operation, fingerprint, JSON.stringify(outcome), this.now());
  }

  private acceptCommandResult(
    conversationId: string,
    commandId: string,
    operation: CommandOperation,
    fingerprint: string,
    frames: readonly MobileV2SequencedFrame[],
  ): CommandMutationResult {
    this.storeCommandOutcome(conversationId, commandId, operation, fingerprint, {
      kind: 'sequenced',
      v2Seqs: frames.map((frame) => frame.v2Seq),
    });
    return {
      replayed: false,
      conversation: this.mapStoredConversation(this.requireConversationRow(conversationId)),
      frames,
    };
  }

  private rejectCommand(
    conversationId: string,
    commandId: string,
    operation: CommandOperation,
    fingerprint: string,
    code: CommandRejectedFrame['code'],
    error: string,
    details?: Record<string, unknown>,
  ): CommandMutationResult {
    const frame: CommandRejectedFrame = {
      type: 'command_rejected',
      id: commandId,
      conversationId,
      code,
      error,
      retryable: false,
      ...(details !== undefined ? { details } : {}),
    };
    this.storeCommandOutcome(conversationId, commandId, operation, fingerprint, {
      kind: 'rejected',
      frame,
    });
    return { replayed: false, frames: [frame] };
  }

  private itemRefreshDetails(
    input: PendingInputRow,
    queueRevision: number,
  ): Record<string, unknown> {
    return {
      inputId: input.input_id,
      state: input.state,
      itemRevision: input.revision,
      queueRevision,
      refreshRequired: true,
    };
  }

  private queueRefreshDetails(conversation: ConversationRow): Record<string, unknown> {
    return {
      queuePaused: conversation.queue_paused === 1,
      queueRevision: conversation.queue_revision,
      pendingFollowUpCount: this.pendingFollowUpCount(conversation.id),
      refreshRequired: true,
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

  private selectMessagePageRows(input: ListMessagesInput): {
    rows: ConversationMessageRow[];
    nextCursor: string | null;
  } {
    if (!Number.isInteger(input.limit) || input.limit <= 0) {
      throw new ConversationServiceError('validation_failed', 'Invalid page limit', 400, false);
    }
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
    return {
      rows: pageRows,
      nextCursor: boundary
        ? encodeMessageCursor({ ordinal: boundary.ordinal, id: boundary.id })
        : null,
    };
  }

  private hydrateStoredMessages(
    conversation: ConversationRow,
    rows: readonly ConversationMessageRow[],
  ): StoredConversationMessage[] {
    const allEvents = this.eventLog.readSince(conversation.agent_id, conversation.id, 0);
    return rows.map((row) => {
      const stored = this.mapStoredMessage(row);
      if (row.role !== 'assistant') return stored;
      const events: MobileAgentEvent[] = allEvents
        .filter(
          (entry) =>
            entry.payload.type === 'event' && (entry.segmentTurnId ?? entry.msgId) === row.turn_id,
        )
        .map((entry) => (entry.payload as { type: 'event'; event: MobileAgentEvent }).event);
      return { ...stored, content: { type: 'assistant', events } };
    });
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
      this.db.prepare('DELETE FROM conversation_pending_inputs WHERE conversation_id = ?').run(id);
      this.db.prepare('DELETE FROM conversation_command_results WHERE conversation_id = ?').run(id);
      this.db.prepare('DELETE FROM conversation_v2_events WHERE conversation_id = ?').run(id);
      this.eventLog.deleteConversation(current.agent_id, id);
      this.db.prepare('DELETE FROM conversation_messages WHERE conversation_id = ?').run(id);
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
    return this.db.transaction(() => {
      const conversation = this.requireConversationRow(input.conversationId);
      const page = this.selectMessagePageRows(input);
      return {
        items: this.hydrateStoredMessages(conversation, page.rows).map(mapMessageV1),
        nextCursor: page.nextCursor,
        throughSeq: conversation.last_seq,
      };
    })();
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
          userMessage: mapMessageV1(this.mapStoredMessage(user)),
          assistantMessage: mapMessageV1(this.mapStoredMessage(assistant)),
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

      const userOrdinal = this.reserveMessageOrdinals(value.conversationId, 2);
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
          id, conversation_id, turn_id, run_id, segment_index, ordinal, role, content, status,
          delivery_kind, delivery_status, created_at, updated_at
        ) VALUES (
          @id, @conversationId, @turnId, @turnId, 0, @ordinal, @role, @content, @status,
          'normal', NULL, @now, @now
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
        userMessage: mapMessageV1(this.mapStoredMessage(user)),
        assistantMessage: mapMessageV1(this.mapStoredMessage(assistant)),
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
      const writable = this.db
        .prepare(`
          SELECT * FROM conversations
          WHERE agent_id = ? AND deleted_at IS NULL AND status NOT IN ('archived', 'deleted')
          ORDER BY id ASC
        `)
        .all(agentId) as ConversationRow[];
      for (const conversation of writable) {
        const pendingSteers = this.db
          .prepare(`
            SELECT input_id, reserved_run_id
            FROM conversation_pending_inputs
            WHERE conversation_id = ? AND kind = 'steer' AND state = 'queued'
            ORDER BY enqueue_order ASC
          `)
          .all(conversation.id) as Array<{ input_id: string; reserved_run_id: string }>;
        for (const pending of pendingSteers) {
          this.terminalizeSteersNotDeliveredInTransaction({
            conversationId: conversation.id,
            runId: pending.reserved_run_id,
            inputIds: [pending.input_id],
            code: 'not_found',
            error: 'Agent archived before this input could be delivered',
          });
        }

        const followUps = this.db
          .prepare(`
            SELECT * FROM conversation_pending_inputs
            WHERE conversation_id = ? AND kind = 'follow_up'
              AND state IN ('queued', 'delivering')
            ORDER BY enqueue_order ASC
          `)
          .all(conversation.id) as PendingInputRow[];
        for (const pending of followUps) {
          const timestamp = this.now();
          const changed = this.db
            .prepare(`
              UPDATE conversation_pending_inputs
              SET state = 'failed', revision = revision + 1,
                  failure_code = 'not_found',
                  failure_message = 'Agent archived before this input could be delivered',
                  updated_at = @now
              WHERE input_id = @inputId AND conversation_id = @conversationId
                AND kind = 'follow_up' AND state IN ('queued', 'delivering')
            `)
            .run({ inputId: pending.input_id, conversationId: conversation.id, now: timestamp });
          if (changed.changes !== 1) {
            throw new Error(`Failed to terminalize archived Follow Up ${pending.input_id}`);
          }
          const advanced = this.advanceQueueMutation(conversation.id);
          const failed = this.selectPendingInput(pending.input_id);
          if (!failed) throw new Error(`Archived Follow Up ${pending.input_id} disappeared`);
          this.appendV2(advanced, {
            type: 'input_failed',
            id: pending.enqueue_command_id,
            conversationId: conversation.id,
            queueRevision: advanced.queue_revision,
            input: this.mapPendingInput(failed),
          });
        }
        const prepared = this.requireConversationRow(conversation.id);
        if (prepared.queue_paused === 1) {
          const resumed = this.advanceQueueMutation(conversation.id, false);
          this.appendV2(resumed, {
            type: 'queue_resumed',
            conversationId: conversation.id,
            queueRevision: resumed.queue_revision,
            queuePaused: false,
            pendingFollowUpCount: this.pendingFollowUpCount(conversation.id),
          });
        }
        const timestamp = this.now();
        const archived = this.db
          .prepare(`
            UPDATE conversations
            SET status = 'archived', active_turn_id = NULL, queue_paused = 0,
                revision = revision + 1, updated_at = @now
            WHERE id = @id AND active_turn_id IS NULL
              AND deleted_at IS NULL AND status NOT IN ('archived', 'deleted')
          `)
          .run({ id: conversation.id, now: timestamp });
        if (archived.changes !== 1) {
          throw new Error(`Failed to archive conversation ${conversation.id}`);
        }
      }
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

  acceptRun(input: AcceptRunInput): AcceptedRun {
    return this.db.transaction((value: AcceptRunInput): AcceptedRun => {
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

      const existingRows = this.db
        .prepare('SELECT * FROM conversation_messages WHERE run_id = ? ORDER BY ordinal ASC')
        .all(value.runId) as ConversationMessageRow[];
      if (existingRows.length > 0) {
        const user = existingRows.find((row) => row.segment_index === 0 && row.role === 'user');
        const assistant = existingRows.find(
          (row) => row.segment_index === 0 && row.role === 'assistant',
        );
        if (
          !user ||
          !assistant ||
          user.conversation_id !== value.conversationId ||
          assistant.conversation_id !== value.conversationId
        ) {
          throw new ConversationServiceError(
            'validation_failed',
            `Run ${value.runId} is already owned by another conversation`,
            409,
            false,
          );
        }
        const accepted = this.eventLog
          .readSince(current.agent_id, current.id, 0)
          .find(
            (entry) =>
              entry.msgId === value.runId &&
              entry.segmentTurnId === user.turn_id &&
              entry.payload.type === 'accepted',
          );
        const v2Frame = this.readV2Rows(current.id, 0).find(
          (frame): frame is AcceptedRun['v2Frame'] =>
            frame.type === 'accepted' &&
            frame.runId === value.runId &&
            frame.segmentTurnId === user.turn_id,
        );
        if (!accepted || accepted.payload.type !== 'accepted' || !v2Frame) {
          throw new ConversationServiceError(
            'validation_failed',
            `Run ${value.runId} is missing its accepted journal entries`,
            409,
            false,
          );
        }
        const userContent = parseContent(user.content);
        return {
          conversation: this.mapStoredConversation(current),
          runId: value.runId,
          segmentTurnId: user.turn_id,
          channelId: value.channelId,
          text: userContent.type === 'user' ? userContent.text : value.text,
          ...(userContent.type === 'user' && userContent.images !== undefined
            ? { images: userContent.images }
            : {}),
          userMessage: this.mapStoredMessage(user),
          assistantMessage: this.mapStoredMessage(assistant),
          v1Seq: accepted.seq,
          v1Payload: accepted.payload,
          v2Frame,
          created: false,
          firstUserMessage: user.ordinal === 1,
        };
      }

      if (
        value.protocol === 'v2' &&
        current.queue_paused === 1 &&
        this.pendingFollowUpCount(current.id) > 0
      ) {
        throw new ConversationServiceError(
          'validation_failed',
          'Resume or remove paused Follow Ups before starting a new turn',
          409,
          false,
          this.queueRefreshDetails(current),
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

      const userOrdinal = this.reserveMessageOrdinals(current.id, 2);
      const userMessageId = this.uuid();
      const assistantMessageId = this.uuid();
      const timestamp = this.now();
      const userContent: ConversationContent = {
        type: 'user',
        text: value.text,
        ...(value.images !== undefined ? { images: value.images } : {}),
      };
      const insertMessage = this.db.prepare(`
        INSERT INTO conversation_messages (
          id, conversation_id, turn_id, run_id, segment_index, ordinal, role, content, status,
          delivery_kind, delivery_status, created_at, updated_at
        ) VALUES (
          @id, @conversationId, @runId, @runId, 0, @ordinal, @role, @content, @status,
          'normal', NULL, @now, @now
        )
      `);
      insertMessage.run({
        id: userMessageId,
        conversationId: current.id,
        runId: value.runId,
        ordinal: userOrdinal,
        role: 'user',
        content: JSON.stringify(userContent),
        status: 'accepted',
        now: timestamp,
      });
      insertMessage.run({
        id: assistantMessageId,
        conversationId: current.id,
        runId: value.runId,
        ordinal: userOrdinal + 1,
        role: 'assistant',
        content: JSON.stringify({ type: 'assistant', events: [] }),
        status: 'streaming',
        now: timestamp,
      });

      const nextRevision = current.revision + 1;
      const acquired = this.db
        .prepare(`
          UPDATE conversations
          SET status = 'running', active_turn_id = @runId, revision = @revision,
              updated_at = @now
          WHERE id = @conversationId AND active_turn_id IS NULL AND deleted_at IS NULL
            AND status NOT IN ('archived', 'deleted')
        `)
        .run({
          conversationId: current.id,
          runId: value.runId,
          revision: nextRevision,
          now: timestamp,
        });
      if (acquired.changes !== 1) {
        throw new Error(`Failed to acquire conversation lease for run ${value.runId}`);
      }
      const accepted = this.appendAcceptedJournals(
        current,
        value.runId,
        value.runId,
        userMessageId,
        assistantMessageId,
        nextRevision,
      );
      const conversation = this.mapStoredConversation(this.requireConversationRow(current.id));
      return {
        conversation,
        runId: value.runId,
        segmentTurnId: value.runId,
        channelId: value.channelId,
        text: value.text,
        ...(value.images !== undefined ? { images: value.images } : {}),
        userMessage: this.mapStoredMessage(this.selectMessageById(userMessageId)),
        assistantMessage: this.mapStoredMessage(this.selectMessageById(assistantMessageId)),
        v1Seq: accepted.v1Seq,
        v1Payload: accepted.v1Payload,
        v2Frame: accepted.v2Frame,
        created: true,
        firstUserMessage: userOrdinal === 1,
      };
    })(input);
  }

  appendRunEvent(input: AppendRunEventInput): PersistedRunFrames | null {
    try {
      return this.db.transaction((value: AppendRunEventInput): PersistedRunFrames | null => {
        const current = this.requireConversationRow(value.conversationId, true);
        if (
          current.status !== 'running' ||
          current.active_turn_id !== value.runId ||
          current.status === 'archived' ||
          current.status === 'deleted'
        ) {
          return null;
        }
        const assistant = this.db
          .prepare(`
            SELECT * FROM conversation_messages
            WHERE conversation_id = @conversationId AND run_id = @runId
              AND role = 'assistant' AND status = 'streaming'
            ORDER BY segment_index DESC, ordinal DESC
            LIMIT 1
          `)
          .get(value) as ConversationMessageRow | undefined;
        if (!assistant || assistant.turn_id !== value.segmentTurnId) return null;
        return this.appendEventJournals(current, value.runId, value.segmentTurnId, value.event);
      })(input);
    } catch (error) {
      if (error instanceof LateTurnEventError) return null;
      throw error;
    }
  }

  appendCurrentRunEvent(
    agentId: string,
    conversationId: string,
    runId: string,
    event: AgentEvent,
  ): PersistedRunFrames | null {
    return this.db.transaction(() => {
      const current = this.requireConversationRow(conversationId, true);
      if (
        current.agent_id !== agentId ||
        current.status !== 'running' ||
        current.active_turn_id !== runId
      ) {
        return null;
      }
      const assistant = this.db
        .prepare(`
          SELECT * FROM conversation_messages
          WHERE conversation_id = ? AND run_id = ? AND role = 'assistant' AND status = 'streaming'
          ORDER BY segment_index DESC, ordinal DESC
          LIMIT 1
        `)
        .get(conversationId, runId) as ConversationMessageRow | undefined;
      if (!assistant) return null;
      return this.appendEventJournals(current, runId, assistant.turn_id, event);
    })();
  }

  deliverSteer(input: DeliverSteerInput): DeliveredInput {
    return this.db.transaction((value: DeliverSteerInput): DeliveredInput => {
      const current = this.requireConversationRow(value.conversationId);
      if (current.status !== 'running' || current.active_turn_id !== value.runId) {
        throw new ConversationServiceError(
          'revision_conflict',
          'Steer target is no longer active',
          409,
          false,
          { activeTurnId: current.active_turn_id, refreshRequired: true },
        );
      }
      const pending = this.selectPendingInput(value.inputId);
      if (
        !pending ||
        pending.conversation_id !== current.id ||
        pending.kind !== 'steer' ||
        pending.state !== 'queued' ||
        pending.reserved_run_id !== value.runId
      ) {
        throw new ConversationServiceError(
          'validation_failed',
          `Steer ${value.inputId} is not queued for this run`,
          409,
          false,
        );
      }
      const previous = this.db
        .prepare(`
          SELECT * FROM conversation_messages
          WHERE conversation_id = ? AND run_id = ? AND role = 'assistant' AND status = 'streaming'
          ORDER BY segment_index DESC, ordinal DESC
          LIMIT 1
        `)
        .get(current.id, value.runId) as ConversationMessageRow | undefined;
      if (!previous) throw new Error(`Run ${value.runId} has no streaming assistant segment`);
      const timestamp = this.now();
      const completed = this.db
        .prepare(`
          UPDATE conversation_messages
          SET status = 'completed', updated_at = @now
          WHERE id = @id AND status = 'streaming'
        `)
        .run({ id: previous.id, now: timestamp });
      if (completed.changes !== 1) throw new Error(`Failed to close segment ${previous.turn_id}`);
      const userChanged = this.db
        .prepare(`
          UPDATE conversation_messages
          SET delivery_status = 'delivered', updated_at = @now
          WHERE id = @id AND role = 'user' AND delivery_kind = 'steer'
            AND delivery_status = 'pending'
        `)
        .run({ id: pending.reserved_user_message_id, now: timestamp });
      if (userChanged.changes !== 1) {
        throw new Error(`Steer user message ${pending.reserved_user_message_id} was not pending`);
      }
      this.db
        .prepare(`
          INSERT INTO conversation_messages (
            id, conversation_id, turn_id, run_id, segment_index, ordinal, role, content, status,
            delivery_kind, delivery_status, created_at, updated_at
          ) VALUES (
            @id, @conversationId, @turnId, @runId, @segmentIndex, @ordinal, 'assistant', @content,
            'streaming', 'steer', NULL, @now, @now
          )
        `)
        .run({
          id: pending.reserved_assistant_message_id,
          conversationId: current.id,
          turnId: pending.reserved_segment_turn_id,
          runId: value.runId,
          segmentIndex: pending.segment_index,
          ordinal: pending.reserved_assistant_ordinal,
          content: JSON.stringify({ type: 'assistant', events: [] }),
          now: timestamp,
        });
      const inputChanged = this.db
        .prepare(`
          UPDATE conversation_pending_inputs
          SET state = 'delivered', revision = revision + 1,
              delivered_at = @now, updated_at = @now
          WHERE input_id = @inputId AND state = 'queued'
        `)
        .run({ inputId: pending.input_id, now: timestamp });
      if (inputChanged.changes !== 1)
        throw new Error(`Failed to deliver Steer ${pending.input_id}`);
      const advanced = this.advanceQueueMutation(current.id);
      const deliveredRow = this.selectPendingInput(pending.input_id);
      if (!deliveredRow) throw new Error(`Delivered Steer ${pending.input_id} disappeared`);
      const frame = this.appendV2(advanced, {
        type: 'input_delivered',
        id: pending.enqueue_command_id,
        conversationId: current.id,
        queueRevision: advanced.queue_revision,
        input: this.mapPendingInput(deliveredRow),
        runId: value.runId,
        segmentTurnId: pending.reserved_segment_turn_id,
        userMessageId: pending.reserved_user_message_id,
        assistantMessageId: pending.reserved_assistant_message_id,
      }) as DeliveredInput['frame'];
      return {
        conversation: this.mapStoredConversation(this.requireConversationRow(current.id)),
        input: this.mapStoredPendingInput(deliveredRow),
        segmentTurnId: pending.reserved_segment_turn_id,
        userMessage: this.mapStoredMessage(
          this.selectMessageById(pending.reserved_user_message_id),
        ),
        assistantMessage: this.mapStoredMessage(
          this.selectMessageById(pending.reserved_assistant_message_id),
        ),
        frame,
      };
    })(input);
  }

  terminalizeSteersNotDelivered(input: TerminalizeSteersInput): PersistedInputTransition[] {
    return this.db.transaction((value: TerminalizeSteersInput) =>
      this.terminalizeSteersNotDeliveredInTransaction(value),
    )(input);
  }

  enqueueInput(input: EnqueueInputCommand): CommandMutationResult {
    const operation = 'enqueue_input' as const;
    return this.db.transaction((value: EnqueueInputCommand): CommandMutationResult => {
      const current = this.requireConversationRow(value.conversationId);
      if (current.agent_id !== value.agentId) {
        throw new ConversationServiceError(
          'not_found',
          `Conversation ${value.conversationId} does not belong to agent ${value.agentId}`,
          404,
          false,
        );
      }
      const fingerprint = commandFingerprint(operation, value);
      const replay = this.replayCommandResult(value.conversationId, value.commandId, fingerprint);
      if (replay) return replay;
      if (current.status === 'archived') {
        return this.rejectCommand(
          current.id,
          value.commandId,
          operation,
          fingerprint,
          'validation_failed',
          'Archived conversations cannot accept queued input',
        );
      }

      const existing = this.selectPendingInput(value.inputId);
      if (existing) {
        return this.rejectCommand(
          current.id,
          value.commandId,
          operation,
          fingerprint,
          'validation_failed',
          'Input ID was already used',
          existing.conversation_id === current.id
            ? this.itemRefreshDetails(existing, current.queue_revision)
            : { inputId: value.inputId, refreshRequired: true },
        );
      }

      const kind = value.behavior === 'steer' ? 'steer' : 'follow_up';
      if (
        kind === 'steer' &&
        (current.active_turn_id === null ||
          value.expectedActiveTurnId === undefined ||
          value.expectedActiveTurnId !== current.active_turn_id)
      ) {
        return this.rejectCommand(
          current.id,
          value.commandId,
          operation,
          fingerprint,
          'revision_conflict',
          'Steer target is no longer active',
          { activeTurnId: current.active_turn_id, refreshRequired: true },
        );
      }

      const payloadBytes = Buffer.byteLength(
        JSON.stringify({ text: value.text, images: value.images }),
      );
      const stats = this.pendingInputStats(current.id);
      const kindCount = kind === 'steer' ? stats.steerCount : stats.followUpCount;
      if (kindCount >= MAX_PENDING_INPUTS_PER_KIND) {
        return this.rejectCommand(
          current.id,
          value.commandId,
          operation,
          fingerprint,
          'validation_failed',
          `Pending ${kind === 'steer' ? 'Steer' : 'Follow Up'} limit reached`,
          {
            kind,
            count: kindCount,
            limit: MAX_PENDING_INPUTS_PER_KIND,
            queueRevision: current.queue_revision,
            refreshRequired: true,
          },
        );
      }
      if (stats.payloadBytes + payloadBytes > MAX_PENDING_INPUT_BYTES) {
        return this.rejectCommand(
          current.id,
          value.commandId,
          operation,
          fingerprint,
          'validation_failed',
          'Pending input byte limit reached',
          {
            payloadBytes,
            pendingBytes: stats.payloadBytes,
            limitBytes: MAX_PENDING_INPUT_BYTES,
            queueRevision: current.queue_revision,
            refreshRequired: true,
          },
        );
      }

      const reservedRunId = kind === 'steer' ? (current.active_turn_id as string) : this.uuid();
      const reservedSegmentTurnId = kind === 'steer' ? this.uuid() : reservedRunId;
      const reservedUserMessageId = this.uuid();
      const reservedAssistantMessageId = this.uuid();
      const segmentIndex = kind === 'steer' ? this.nextSegmentIndex(current.id, reservedRunId) : 0;
      const reservedUserOrdinal =
        kind === 'steer' ? this.reserveMessageOrdinals(current.id, 2) : null;
      const timestamp = this.now();
      this.db
        .prepare(`
          INSERT INTO conversation_pending_inputs (
            input_id, enqueue_command_id, conversation_id, agent_id, channel_id, kind,
            target_turn_id, text, images_json, payload_bytes, state, revision, enqueue_order,
            reserved_run_id, reserved_segment_turn_id, reserved_user_message_id,
            reserved_assistant_message_id, reserved_user_ordinal, reserved_assistant_ordinal,
            segment_index, created_at, updated_at
          ) VALUES (
            @inputId, @commandId, @conversationId, @agentId, @channelId, @kind,
            @targetTurnId, @text, @imagesJson, @payloadBytes, 'queued', 1, @enqueueOrder,
            @reservedRunId, @reservedSegmentTurnId, @reservedUserMessageId,
            @reservedAssistantMessageId, @reservedUserOrdinal, @reservedAssistantOrdinal,
            @segmentIndex, @now, @now
          )
        `)
        .run({
          inputId: value.inputId,
          commandId: value.commandId,
          conversationId: current.id,
          agentId: value.agentId,
          channelId: value.channelId,
          kind,
          targetTurnId: current.active_turn_id,
          text: value.text,
          imagesJson: value.images === undefined ? null : JSON.stringify(value.images),
          payloadBytes,
          enqueueOrder: this.nextEnqueueOrder(current.id),
          reservedRunId,
          reservedSegmentTurnId,
          reservedUserMessageId,
          reservedAssistantMessageId,
          reservedUserOrdinal,
          reservedAssistantOrdinal: reservedUserOrdinal === null ? null : reservedUserOrdinal + 1,
          segmentIndex,
          now: timestamp,
        });

      if (kind === 'steer') {
        const content: ConversationContent = {
          type: 'user',
          text: value.text,
          ...(value.images !== undefined ? { images: value.images } : {}),
        };
        this.db
          .prepare(`
            INSERT INTO conversation_messages (
              id, conversation_id, turn_id, run_id, segment_index, ordinal, role, content,
              status, delivery_kind, delivery_status, created_at, updated_at
            ) VALUES (
              @id, @conversationId, @turnId, @runId, @segmentIndex, @ordinal, 'user', @content,
              'accepted', 'steer', 'pending', @now, @now
            )
          `)
          .run({
            id: reservedUserMessageId,
            conversationId: current.id,
            turnId: reservedSegmentTurnId,
            runId: reservedRunId,
            segmentIndex,
            ordinal: reservedUserOrdinal,
            content: JSON.stringify(content),
            now: timestamp,
          });
      }

      const advanced = this.advanceQueueMutation(current.id);
      const storedInput = this.selectPendingInput(value.inputId);
      if (!storedInput) throw new Error(`Input ${value.inputId} was not found after enqueue`);
      const frame = this.appendV2(advanced, {
        type: 'input_accepted',
        id: value.commandId,
        conversationId: current.id,
        queueRevision: advanced.queue_revision,
        input: this.mapPendingInput(storedInput),
      });
      const frames: MobileV2SequencedFrame[] = [frame];
      const claimed = kind === 'follow_up' ? this.claimNextFollowUpInTransaction(current.id) : null;
      if (claimed) frames.push(claimed.transition.frame, claimed.run.v2Frame);
      const result = this.acceptCommandResult(
        current.id,
        value.commandId,
        operation,
        fingerprint,
        frames,
      );
      return claimed ? { ...result, promotedRun: claimed.run } : result;
    })(input);
  }

  editFollowUp(input: EditFollowUpCommand): CommandMutationResult {
    const operation = 'edit_follow_up' as const;
    return this.db.transaction((value: EditFollowUpCommand): CommandMutationResult => {
      const current = this.requireConversationRow(value.conversationId);
      const fingerprint = commandFingerprint(operation, value);
      const replay = this.replayCommandResult(value.conversationId, value.commandId, fingerprint);
      if (replay) return replay;
      const pending = this.selectPendingInput(value.inputId);
      if (!pending || pending.conversation_id !== current.id) {
        return this.rejectCommand(
          current.id,
          value.commandId,
          operation,
          fingerprint,
          'not_found',
          `Follow Up ${value.inputId} was not found`,
          { inputId: value.inputId, queueRevision: current.queue_revision, refreshRequired: true },
        );
      }
      const refreshDetails = this.itemRefreshDetails(pending, current.queue_revision);
      if (pending.revision !== value.expectedRevision) {
        return this.rejectCommand(
          current.id,
          value.commandId,
          operation,
          fingerprint,
          'revision_conflict',
          `Follow Up revision ${value.expectedRevision} is stale`,
          refreshDetails,
        );
      }
      if (pending.kind !== 'follow_up' || pending.state !== 'queued') {
        return this.rejectCommand(
          current.id,
          value.commandId,
          operation,
          fingerprint,
          'validation_failed',
          'Only queued Follow Ups can be edited',
          refreshDetails,
        );
      }
      if (current.status === 'archived') {
        return this.rejectCommand(
          current.id,
          value.commandId,
          operation,
          fingerprint,
          'validation_failed',
          'Archived conversations cannot edit queued input',
          refreshDetails,
        );
      }

      const payloadBytes = Buffer.byteLength(
        JSON.stringify({ text: value.text, images: value.images }),
      );
      const stats = this.pendingInputStats(current.id);
      if (stats.payloadBytes - pending.payload_bytes + payloadBytes > MAX_PENDING_INPUT_BYTES) {
        return this.rejectCommand(
          current.id,
          value.commandId,
          operation,
          fingerprint,
          'validation_failed',
          'Pending input byte limit reached',
          {
            payloadBytes,
            pendingBytes: stats.payloadBytes,
            limitBytes: MAX_PENDING_INPUT_BYTES,
            queueRevision: current.queue_revision,
            refreshRequired: true,
          },
        );
      }

      const changed = this.db
        .prepare(`
          UPDATE conversation_pending_inputs
          SET text = @text, images_json = @imagesJson, payload_bytes = @payloadBytes,
              revision = revision + 1, updated_at = @now
          WHERE input_id = @inputId AND conversation_id = @conversationId
            AND kind = 'follow_up' AND state = 'queued' AND revision = @expectedRevision
        `)
        .run({
          inputId: value.inputId,
          conversationId: current.id,
          expectedRevision: value.expectedRevision,
          text: value.text,
          imagesJson: value.images === undefined ? null : JSON.stringify(value.images),
          payloadBytes,
          now: this.now(),
        });
      if (changed.changes !== 1) throw new Error(`Failed to edit Follow Up ${value.inputId}`);
      const advanced = this.advanceQueueMutation(current.id);
      const freshInput = this.selectPendingInput(value.inputId);
      if (!freshInput) throw new Error(`Follow Up ${value.inputId} was not found after edit`);
      const frame = this.appendV2(advanced, {
        type: 'input_updated',
        id: value.commandId,
        conversationId: current.id,
        queueRevision: advanced.queue_revision,
        input: this.mapPendingInput(freshInput),
      });
      return this.acceptCommandResult(current.id, value.commandId, operation, fingerprint, [frame]);
    })(input);
  }

  removeFollowUp(input: RemoveFollowUpCommand): CommandMutationResult {
    const operation = 'remove_follow_up' as const;
    return this.db.transaction((value: RemoveFollowUpCommand): CommandMutationResult => {
      const current = this.requireConversationRow(value.conversationId);
      const fingerprint = commandFingerprint(operation, value);
      const replay = this.replayCommandResult(value.conversationId, value.commandId, fingerprint);
      if (replay) return replay;
      const pending = this.selectPendingInput(value.inputId);
      if (!pending || pending.conversation_id !== current.id) {
        return this.rejectCommand(
          current.id,
          value.commandId,
          operation,
          fingerprint,
          'not_found',
          `Follow Up ${value.inputId} was not found`,
          { inputId: value.inputId, queueRevision: current.queue_revision, refreshRequired: true },
        );
      }
      const refreshDetails = this.itemRefreshDetails(pending, current.queue_revision);
      if (pending.revision !== value.expectedRevision) {
        return this.rejectCommand(
          current.id,
          value.commandId,
          operation,
          fingerprint,
          'revision_conflict',
          `Follow Up revision ${value.expectedRevision} is stale`,
          refreshDetails,
        );
      }
      if (pending.kind !== 'follow_up' || pending.state !== 'queued') {
        return this.rejectCommand(
          current.id,
          value.commandId,
          operation,
          fingerprint,
          'validation_failed',
          'Only queued Follow Ups can be removed',
          refreshDetails,
        );
      }
      if (current.status === 'archived') {
        return this.rejectCommand(
          current.id,
          value.commandId,
          operation,
          fingerprint,
          'validation_failed',
          'Archived conversations cannot remove queued input',
          refreshDetails,
        );
      }

      const changed = this.db
        .prepare(`
          UPDATE conversation_pending_inputs
          SET state = 'removed', revision = revision + 1, updated_at = @now
          WHERE input_id = @inputId AND conversation_id = @conversationId
            AND kind = 'follow_up' AND state = 'queued' AND revision = @expectedRevision
        `)
        .run({
          inputId: value.inputId,
          conversationId: current.id,
          expectedRevision: value.expectedRevision,
          now: this.now(),
        });
      if (changed.changes !== 1) throw new Error(`Failed to remove Follow Up ${value.inputId}`);
      const pendingFollowUpCount = this.pendingFollowUpCount(current.id);
      const clearedPause = current.queue_paused === 1 && pendingFollowUpCount === 0;
      const advanced = this.advanceQueueMutation(current.id, clearedPause ? false : undefined);
      const freshInput = this.selectPendingInput(value.inputId);
      if (!freshInput) throw new Error(`Follow Up ${value.inputId} was not found after removal`);
      const frames: MobileV2SequencedFrame[] = [
        this.appendV2(advanced, {
          type: 'input_removed',
          id: value.commandId,
          conversationId: current.id,
          queueRevision: advanced.queue_revision,
          input: this.mapPendingInput(freshInput),
        }),
      ];
      if (clearedPause) {
        frames.push(
          this.appendV2(advanced, {
            type: 'queue_resumed',
            id: value.commandId,
            conversationId: current.id,
            queueRevision: advanced.queue_revision,
            queuePaused: false,
            pendingFollowUpCount,
          }),
        );
      }
      return this.acceptCommandResult(current.id, value.commandId, operation, fingerprint, frames);
    })(input);
  }

  resumeFollowUps(input: ResumeFollowUpsCommand): CommandMutationResult {
    const operation = 'resume_follow_ups' as const;
    return this.db.transaction((value: ResumeFollowUpsCommand): CommandMutationResult => {
      const current = this.requireConversationRow(value.conversationId);
      const fingerprint = commandFingerprint(operation, value);
      const replay = this.replayCommandResult(value.conversationId, value.commandId, fingerprint);
      if (replay) return replay;
      const refreshDetails = this.queueRefreshDetails(current);
      if (current.queue_revision !== value.expectedQueueRevision) {
        return this.rejectCommand(
          current.id,
          value.commandId,
          operation,
          fingerprint,
          'revision_conflict',
          `Queue revision ${value.expectedQueueRevision} is stale`,
          refreshDetails,
        );
      }
      if (current.queue_paused !== 1) {
        return this.rejectCommand(
          current.id,
          value.commandId,
          operation,
          fingerprint,
          'validation_failed',
          'Follow Up queue is not paused',
          refreshDetails,
        );
      }
      if (current.status === 'archived') {
        return this.rejectCommand(
          current.id,
          value.commandId,
          operation,
          fingerprint,
          'validation_failed',
          'Archived conversations cannot resume queued input',
          refreshDetails,
        );
      }

      const advanced = this.advanceQueueMutation(current.id, false);
      const frame = this.appendV2(advanced, {
        type: 'queue_resumed',
        id: value.commandId,
        conversationId: current.id,
        queueRevision: advanced.queue_revision,
        queuePaused: false,
        pendingFollowUpCount: this.pendingFollowUpCount(current.id),
      });
      const frames: MobileV2SequencedFrame[] = [frame];
      const claimed = this.claimNextFollowUpInTransaction(current.id);
      if (claimed) frames.push(claimed.transition.frame, claimed.run.v2Frame);
      const result = this.acceptCommandResult(
        current.id,
        value.commandId,
        operation,
        fingerprint,
        frames,
      );
      return claimed ? { ...result, promotedRun: claimed.run } : result;
    })(input);
  }

  pauseFollowUpsForAgentDisable(agentId: string): PersistedQueueTransition[] {
    return this.db.transaction(() => {
      const conversations = this.db
        .prepare(`
          SELECT *
          FROM conversations
          WHERE agent_id = @agentId AND deleted_at IS NULL
            AND status NOT IN ('archived', 'deleted') AND queue_paused = 0
            AND EXISTS (
              SELECT 1
              FROM conversation_pending_inputs
              WHERE conversation_id = conversations.id
                AND kind = 'follow_up' AND state = 'queued'
            )
          ORDER BY id ASC
        `)
        .all({ agentId }) as ConversationRow[];
      return conversations.map((conversation): PersistedQueueTransition => {
        const advanced = this.advanceQueueMutation(conversation.id, true);
        const frame = this.appendV2(advanced, {
          type: 'queue_paused',
          conversationId: conversation.id,
          queueRevision: advanced.queue_revision,
          queuePaused: true,
          pendingFollowUpCount: this.pendingFollowUpCount(conversation.id),
        });
        return {
          conversation: this.mapStoredConversation(this.requireConversationRow(conversation.id)),
          frame: frame as PersistedQueueTransition['frame'],
        };
      });
    })();
  }

  finishRunAndClaimNext(input: FinishRunInput): FinishRunResult {
    return this.db.transaction((value: FinishRunInput): FinishRunResult => {
      const current = this.requireConversationRow(value.conversationId, true);
      const existingV1 = this.eventLog
        .readSince(current.agent_id, current.id, 0)
        .findLast(
          (entry) =>
            entry.msgId === value.runId &&
            entry.segmentTurnId === value.segmentTurnId &&
            isTerminalPayload(entry.payload),
        );
      const existingV2 = this.readV2Rows(current.id, 0).findLast(
        (frame) =>
          frame.runId === value.runId &&
          frame.segmentTurnId === value.segmentTurnId &&
          (frame.type === 'done' || frame.type === 'error'),
      );
      if (existingV1 && existingV2) {
        return {
          terminal: {
            conversation: this.mapStoredConversation(current),
            v1Seq: existingV1.seq,
            v1Payload: existingV1.payload,
            v2Frame: existingV2,
          },
          transitions: [],
        };
      }

      this.assertTurnWritable(current);
      if (current.status !== 'running' || current.active_turn_id !== value.runId) {
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
          `Run ${value.runId} is not active`,
          409,
          false,
        );
      }
      const assistant = this.db
        .prepare(`
          SELECT * FROM conversation_messages
          WHERE conversation_id = @conversationId AND run_id = @runId
            AND turn_id = @segmentTurnId AND role = 'assistant'
        `)
        .get(value) as ConversationMessageRow | undefined;
      if (!assistant || assistant.status !== 'streaming') {
        throw new ConversationServiceError(
          'validation_failed',
          `Segment ${value.segmentTurnId} is not the current streaming assistant`,
          409,
          false,
        );
      }
      const nonterminalEarlier = this.db
        .prepare(`
          SELECT COUNT(*)
          FROM conversation_messages
          WHERE conversation_id = @conversationId AND run_id = @runId
            AND role = 'assistant' AND turn_id <> @segmentTurnId
            AND status IN ('accepted', 'streaming')
        `)
        .pluck()
        .get(value) as number;
      if (nonterminalEarlier !== 0) {
        throw new Error(`Run ${value.runId} has an earlier nonterminal assistant segment`);
      }

      const v1Payload: EventLogPayload =
        value.outcome === 'failed'
          ? {
              type: 'error',
              error: value.error,
              ...(value.code !== undefined ? { code: value.code } : {}),
              retryable: value.retryable,
            }
          : value.outcome === 'interrupted'
            ? {
                type: 'error',
                error: 'Gateway restarted while this turn was in progress.',
                code: 'gateway_offline',
                retryable: true,
              }
            : { type: 'done', outcome: value.outcome };
      const assistantStatus: ConversationMessage['status'] =
        value.outcome === 'failed' ? 'failed' : value.outcome;
      const timestamp = this.now();
      const v1Seq = this.eventLog.append(
        current.agent_id,
        current.id,
        value.runId,
        v1Payload,
        value.segmentTurnId,
      );
      const assistantChanged = this.db
        .prepare(`
          UPDATE conversation_messages
          SET status = @status, updated_at = @now
          WHERE id = @id AND status = 'streaming'
        `)
        .run({ id: assistant.id, status: assistantStatus, now: timestamp });
      if (assistantChanged.changes !== 1) {
        throw new Error(`Failed to terminalize assistant segment ${value.segmentTurnId}`);
      }
      const released = this.db
        .prepare(`
          UPDATE conversations
          SET status = @status, active_turn_id = NULL, revision = revision + 1,
              last_seq = @lastSeq, updated_at = @now
          WHERE id = @conversationId AND status = 'running' AND active_turn_id = @runId
        `)
        .run({
          conversationId: current.id,
          runId: value.runId,
          status: value.outcome === 'interrupted' ? 'interrupted' : 'idle',
          lastSeq: v1Seq,
          now: timestamp,
        });
      if (released.changes !== 1) throw new Error(`Failed to release run ${value.runId}`);
      const afterRelease = this.requireConversationRow(current.id);
      const v2Frame =
        value.outcome === 'failed'
          ? this.appendV2(afterRelease, {
              type: 'error',
              id: value.runId,
              conversationId: current.id,
              runId: value.runId,
              segmentTurnId: value.segmentTurnId,
              error: value.error,
              ...(value.code !== undefined ? { code: value.code } : {}),
              retryable: value.retryable,
            })
          : this.appendV2(afterRelease, {
              type: 'done',
              id: value.runId,
              conversationId: current.id,
              runId: value.runId,
              segmentTurnId: value.segmentTurnId,
              outcome: value.outcome,
            });
      const transitions: FinishRunResult['transitions'] = [];
      if (
        value.outcome === 'failed' &&
        afterRelease.queue_paused === 0 &&
        this.pendingFollowUpCount(current.id) > 0
      ) {
        const paused = this.advanceQueueMutation(current.id, true);
        const frame = this.appendV2(paused, {
          type: 'queue_paused',
          conversationId: current.id,
          queueRevision: paused.queue_revision,
          queuePaused: true,
          pendingFollowUpCount: this.pendingFollowUpCount(current.id),
        }) as PersistedQueueTransition['frame'];
        transitions.push({
          conversation: this.mapStoredConversation(this.requireConversationRow(current.id)),
          frame,
        });
      }

      const claimed =
        value.outcome !== 'failed' && value.suppressPromotion !== true
          ? this.claimNextFollowUpInTransaction(current.id)
          : null;
      if (claimed) transitions.push(claimed.transition);
      return {
        terminal: {
          conversation: this.mapStoredConversation(this.requireConversationRow(current.id)),
          v1Seq,
          v1Payload,
          v2Frame,
        },
        transitions,
        ...(claimed ? { claimedRun: claimed.run } : {}),
      };
    })(input);
  }

  claimNextFollowUp(conversationId: string): ClaimedFollowUp | null {
    return this.db.transaction(() => this.claimNextFollowUpInTransaction(conversationId))();
  }

  bootstrapV2(input: ListMessagesInput): MobileV2ConversationBootstrap {
    return this.db.transaction((value: ListMessagesInput): MobileV2ConversationBootstrap => {
      const conversationRow = this.requireConversationRow(value.conversationId);
      const page = this.selectMessagePageRows(value);
      const pendingRows = this.db
        .prepare(`
          SELECT * FROM conversation_pending_inputs
          WHERE conversation_id = @conversationId
            AND (
              (kind = 'steer' AND state = 'queued')
              OR (kind = 'follow_up' AND state IN ('queued', 'delivering'))
            )
          ORDER BY enqueue_order ASC
        `)
        .all({ conversationId: value.conversationId }) as PendingInputRow[];
      const conversation = this.mapStoredConversation(conversationRow);
      return {
        conversation: mapConversationV2(conversation),
        messages: this.hydrateStoredMessages(conversationRow, page.rows).map(mapMessageV2),
        nextCursor: page.nextCursor,
        pendingInputs: pendingRows.map((row) => this.mapPendingInput(row)),
        queuePaused: conversation.queuePaused,
        queueRevision: conversation.queueRevision,
        v2ThroughSeq: conversation.v2LastSeq,
      };
    })(input);
  }

  readV2Since(agentId: string, conversationId: string, sinceV2Seq: number): V2ReplayResult {
    return this.db.transaction(() => {
      const conversation = this.requireConversationRow(conversationId);
      if (conversation.agent_id !== agentId) {
        throw new ConversationServiceError(
          'not_found',
          `Conversation ${conversationId} does not belong to agent ${agentId}`,
          404,
          false,
        );
      }
      return {
        frames: this.readV2Rows(conversationId, sinceV2Seq),
        throughSeq: conversation.v2_last_seq,
      };
    })();
  }

  listDeliveredSteers(conversationId: string): DeliveredSteerContext[] {
    return this.db.transaction(() => {
      this.requireConversationRow(conversationId);
      const rows = this.db
        .prepare(`
          SELECT input_id, text, images_json
          FROM conversation_pending_inputs
          WHERE conversation_id = ? AND kind = 'steer' AND state = 'delivered'
          ORDER BY reserved_user_ordinal ASC, enqueue_order ASC
        `)
        .all(conversationId) as Array<{
        input_id: string;
        text: string;
        images_json: string | null;
      }>;
      return rows.map((row) => ({
        inputId: row.input_id,
        text: row.text,
        ...(row.images_json !== null
          ? { images: JSON.parse(row.images_json) as DeliveredSteerContext['images'] }
          : {}),
      }));
    })();
  }

  recoverV2State(): V2RecoveryResult {
    return this.db.transaction(() => {
      const activeRows = this.db
        .prepare(`
          SELECT * FROM conversations
          WHERE status = 'running' AND active_turn_id IS NOT NULL AND deleted_at IS NULL
            AND status NOT IN ('archived', 'deleted')
          ORDER BY id ASC
        `)
        .all() as ConversationRow[];
      let conversationsInterrupted = 0;
      let terminalsAppended = 0;

      for (const conversation of activeRows) {
        const runId = conversation.active_turn_id as string;
        const assistant = this.db
          .prepare(`
            SELECT * FROM conversation_messages
            WHERE conversation_id = ? AND run_id = ? AND role = 'assistant'
              AND status = 'streaming'
            ORDER BY segment_index DESC, ordinal DESC
            LIMIT 1
          `)
          .get(conversation.id, runId) as ConversationMessageRow | undefined;
        if (!assistant) {
          this.db
            .prepare(`
              UPDATE conversations
              SET status = 'interrupted', active_turn_id = NULL,
                  revision = revision + 1, updated_at = @now
              WHERE id = @id AND active_turn_id = @runId
            `)
            .run({ id: conversation.id, runId, now: this.now() });
          conversationsInterrupted++;
          continue;
        }
        const representedDeliveries = this.db
          .prepare(`
            SELECT * FROM conversation_pending_inputs
            WHERE conversation_id = @conversationId AND kind = 'follow_up'
              AND state = 'delivering' AND reserved_run_id = @runId
              AND EXISTS (
                SELECT 1 FROM conversation_messages
                WHERE conversation_id = @conversationId AND run_id = @runId
                  AND id = conversation_pending_inputs.reserved_assistant_message_id
              )
            ORDER BY enqueue_order ASC
          `)
          .all({ conversationId: conversation.id, runId }) as PendingInputRow[];
        for (const pending of representedDeliveries) {
          const timestamp = this.now();
          const journaledDelivery = this.readV2Rows(pending.conversation_id, 0).find(
            (frame): frame is Extract<MobileV2SequencedFrame, { type: 'input_delivered' }> =>
              frame.type === 'input_delivered' &&
              frame.input.inputId === pending.input_id &&
              frame.runId === pending.reserved_run_id,
          );
          if (journaledDelivery) {
            const repaired = this.db
              .prepare(`
                UPDATE conversation_pending_inputs
                SET state = 'delivered', revision = @revision,
                    delivered_at = @deliveredAt, updated_at = @updatedAt
                WHERE input_id = @inputId AND state = 'delivering'
              `)
              .run({
                inputId: pending.input_id,
                revision: journaledDelivery.input.revision,
                deliveredAt: journaledDelivery.input.deliveredAt ?? null,
                updatedAt: journaledDelivery.input.updatedAt,
              });
            if (repaired.changes !== 1) {
              throw new Error(`Failed to repair delivered Follow Up ${pending.input_id}`);
            }
            continue;
          }
          const changed = this.db
            .prepare(`
              UPDATE conversation_pending_inputs
              SET state = 'delivered', revision = revision + 1,
                  delivered_at = COALESCE(delivered_at, @now), updated_at = @now
              WHERE input_id = @inputId AND state = 'delivering'
            `)
            .run({ inputId: pending.input_id, now: timestamp });
          if (changed.changes !== 1) continue;
          const advanced = this.advanceQueueMutation(pending.conversation_id);
          const delivered = this.selectPendingInput(pending.input_id);
          if (!delivered) throw new Error(`Recovered Follow Up ${pending.input_id} disappeared`);
          this.appendV2(advanced, {
            type: 'input_delivered',
            id: pending.enqueue_command_id,
            conversationId: pending.conversation_id,
            queueRevision: advanced.queue_revision,
            input: this.mapPendingInput(delivered),
            runId: pending.reserved_run_id,
            segmentTurnId: pending.reserved_segment_turn_id,
            userMessageId: pending.reserved_user_message_id,
            assistantMessageId: pending.reserved_assistant_message_id,
          });
        }
        const pendingSteerIds = this.db
          .prepare(`
            SELECT input_id
            FROM conversation_pending_inputs
            WHERE conversation_id = ? AND kind = 'steer' AND state = 'queued'
              AND reserved_run_id = ?
            ORDER BY enqueue_order ASC
          `)
          .all(conversation.id, runId)
          .map((row) => (row as { input_id: string }).input_id);
        this.terminalizeSteersNotDeliveredInTransaction({
          conversationId: conversation.id,
          runId,
          inputIds: pendingSteerIds,
          code: 'gateway_offline',
          error: 'Gateway restarted before this Steer could be delivered.',
        });
        this.finishRunAndClaimNext({
          conversationId: conversation.id,
          runId,
          segmentTurnId: assistant.turn_id,
          outcome: 'interrupted',
          suppressPromotion: true,
        });
        conversationsInterrupted++;
        terminalsAppended++;
      }

      const deliveringRows = this.db
        .prepare(`
          SELECT * FROM conversation_pending_inputs
          WHERE kind = 'follow_up' AND state = 'delivering'
          ORDER BY conversation_id ASC, enqueue_order ASC
        `)
        .all() as PendingInputRow[];
      for (const pending of deliveringRows) {
        const timestamp = this.now();
        const changed = this.db
          .prepare(`
            UPDATE conversation_pending_inputs
            SET state = 'queued', revision = revision + 1, updated_at = @now
            WHERE input_id = @inputId AND state = 'delivering'
          `)
          .run({ inputId: pending.input_id, now: timestamp });
        if (changed.changes !== 1) continue;
        const advanced = this.advanceQueueMutation(pending.conversation_id);
        const queued = this.selectPendingInput(pending.input_id);
        if (!queued) throw new Error(`Released Follow Up ${pending.input_id} disappeared`);
        this.appendV2(advanced, {
          type: 'input_updated',
          id: pending.enqueue_command_id,
          conversationId: pending.conversation_id,
          queueRevision: advanced.queue_revision,
          input: this.mapPendingInput(queued),
        });
      }

      const eligibleConversationIds = this.db
        .prepare(`
          SELECT id
          FROM conversations
          WHERE deleted_at IS NULL AND status NOT IN ('archived', 'deleted')
            AND active_turn_id IS NULL AND queue_paused = 0
            AND EXISTS (
              SELECT 1 FROM conversation_pending_inputs
              WHERE conversation_id = conversations.id
                AND kind = 'follow_up' AND state = 'queued'
            )
          ORDER BY id ASC
        `)
        .all()
        .map((row) => (row as { id: string }).id);
      return { conversationsInterrupted, terminalsAppended, eligibleConversationIds };
    })();
  }

  listRunMessages(conversationId: string, runId: string): StoredConversationMessage[] {
    return this.db.transaction(() => {
      const conversation = this.requireConversationRow(conversationId);
      const rows = this.db
        .prepare(`
          SELECT * FROM conversation_messages
          WHERE conversation_id = ? AND run_id = ?
          ORDER BY ordinal ASC, id ASC
        `)
        .all(conversationId, runId) as ConversationMessageRow[];
      return this.hydrateStoredMessages(conversation, rows);
    })();
  }

  close(): void {
    this.eventLog.close();
    this.db.close();
  }
}
