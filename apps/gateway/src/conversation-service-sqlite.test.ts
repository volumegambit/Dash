import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MobileV2SequencedFrame } from '@dash/mobile-contract-v2';
import Database, { type Database as DatabaseType } from 'better-sqlite3';
import type {
  EditFollowUpCommand,
  EnqueueInputCommand,
  MobileV2SequencedPayload,
  RemoveFollowUpCommand,
  ResumeFollowUpsCommand,
} from './conversation-domain.js';
import { SqliteConversationService } from './conversation-service-sqlite.js';
import { ConversationServiceError, DEFAULT_CONVERSATION_TITLE } from './conversation-service.js';

describe('SqliteConversationService schema', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'conversation-service-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('expands the existing event database without losing rows', () => {
    const legacy = new Database(join(tmpDir, 'agent-stream-events.db'));
    legacy.exec(`
      CREATE TABLE agent_stream_events (
        agent_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        msg_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        PRIMARY KEY (agent_id, conversation_id, seq)
      );
      INSERT INTO agent_stream_events VALUES
        ('agent-legacy', 'conversation-legacy', 1, 'turn-legacy',
         '{"type":"done"}', '2026-07-01T00:00:00.000Z');
    `);
    legacy.close();

    const service = new SqliteConversationService({ dataDir: tmpDir });
    expect(service.eventLog.readSince('agent-legacy', 'conversation-legacy', 0)).toHaveLength(1);

    const serviceDb = (service as unknown as { db: DatabaseType }).db;
    expect(serviceDb.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(serviceDb.pragma('journal_mode', { simple: true })).toBe('wal');

    const inspect = new Database(join(tmpDir, 'agent-stream-events.db'), { readonly: true });
    expect(
      inspect
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all()
        .map((row) => (row as { name: string }).name),
    ).toEqual(
      expect.arrayContaining(['agent_stream_events', 'conversations', 'conversation_messages']),
    );
    expect(
      inspect
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name")
        .all()
        .map((row) => (row as { name: string }).name),
    ).toEqual(
      expect.arrayContaining([
        'conversations_list_idx',
        'conversations_agent_list_idx',
        'conversation_messages_page_idx',
        'stream_events_turn_idx',
      ]),
    );
    inspect.close();
    service.close();
  });

  it('owns and closes the shared database exactly once', () => {
    const close = vi.spyOn(Database.prototype, 'close');
    const service = new SqliteConversationService({ dataDir: tmpDir });

    service.eventLog.close();
    expect(close).not.toHaveBeenCalled();
    service.close();
    expect(close).toHaveBeenCalledTimes(1);

    close.mockRestore();
  });

  it('keeps v1 and v2 journal sequences independent', () => {
    const service = new SqliteConversationService({
      dataDir: tmpDir,
      now: () => '2026-07-12T00:00:00.000Z',
      uuid: () => '00000000-0000-4000-8000-000000000001',
    });
    const conversation = service.create({
      agentId: 'agent-01',
      agentName: 'Helper',
      requestId: 'request-01',
    });
    const storage = service as unknown as {
      db: DatabaseType;
      appendV2(conversation: unknown, payload: MobileV2SequencedPayload): MobileV2SequencedFrame;
    };
    const row = storage.db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversation.id);
    const queuePayloadWithStaleCursor = {
      type: 'queue_paused' as const,
      conversationId: conversation.id,
      queueRevision: 1,
      queuePaused: true,
      pendingFollowUpCount: 0,
      v2Seq: 999,
    };

    const frames = storage.db.transaction(() => {
      expect(
        service.eventLog.append('agent-01', conversation.id, 'run-01', {
          type: 'event',
          event: { type: 'text_delta', text: 'one' },
        }),
      ).toBe(1);
      const first = storage.appendV2(row, {
        type: 'event',
        id: 'event-01',
        conversationId: conversation.id,
        runId: 'run-01',
        segmentTurnId: 'segment-01',
        event: { type: 'text_delta', text: 'one' },
      });
      const queueOnly = storage.appendV2(row, queuePayloadWithStaleCursor);
      expect(
        service.eventLog.append('agent-01', conversation.id, 'run-01', {
          type: 'done',
          outcome: 'completed',
        }),
      ).toBe(2);
      const terminal = storage.appendV2(row, {
        type: 'done',
        id: 'event-02',
        conversationId: conversation.id,
        runId: 'run-01',
        segmentTurnId: 'segment-01',
        outcome: 'completed',
      });
      return [first, queueOnly, terminal];
    })();

    expect(
      service.eventLog.readSince('agent-01', conversation.id, 0).map(({ seq }) => seq),
    ).toEqual([1, 2]);
    expect(frames.map(({ v2Seq }) => v2Seq)).toEqual([1, 2, 3]);
    expect(service.readV2Since('agent-01', conversation.id, 0)).toEqual(frames);
    expect(
      JSON.parse(
        storage.db
          .prepare('SELECT payload FROM conversation_v2_events WHERE v2_seq = 2')
          .pluck()
          .get() as string,
      ),
    ).not.toHaveProperty('v2Seq');
    expect(service.eventLog.listInterrupted()).toEqual([]);
    service.close();
  });

  it('rolls a v2 append back with the caller transaction', () => {
    const service = new SqliteConversationService({
      dataDir: tmpDir,
      uuid: () => '00000000-0000-4000-8000-000000000001',
    });
    const conversation = service.create({
      agentId: 'agent-01',
      agentName: 'Helper',
      requestId: 'request-01',
    });
    const storage = service as unknown as {
      db: DatabaseType;
      appendV2(conversation: unknown, payload: MobileV2SequencedPayload): MobileV2SequencedFrame;
    };

    expect(() =>
      storage.db.transaction(() => {
        const row = storage.db
          .prepare('SELECT * FROM conversations WHERE id = ?')
          .get(conversation.id);
        storage.appendV2(row, {
          type: 'queue_paused',
          conversationId: conversation.id,
          queueRevision: 1,
          queuePaused: true,
          pendingFollowUpCount: 0,
        });
        throw new Error('roll back');
      })(),
    ).toThrow('roll back');

    expect(service.readV2Since('agent-01', conversation.id, 0)).toEqual([]);
    expect(
      storage.db
        .prepare('SELECT v2_last_seq FROM conversations WHERE id = ?')
        .pluck()
        .get(conversation.id),
    ).toBe(0);
    service.close();
  });

  it('creates an idempotent canonical conversation with snapshot metadata', () => {
    const id = '00000000-0000-4000-8000-000000000001';
    const timestamp = '2026-07-12T00:00:00.000Z';
    const service = new SqliteConversationService({
      dataDir: tmpDir,
      now: () => timestamp,
      uuid: () => id,
    });

    const created = service.create({
      agentId: 'agent-01',
      agentName: 'Helper',
      requestId: 'request-01',
      title: '   ',
    });

    expect(created).toEqual({
      id,
      agentId: 'agent-01',
      agentName: 'Helper',
      title: DEFAULT_CONVERSATION_TITLE,
      revision: 1,
      status: 'idle',
      activeTurnId: null,
      owningIssueId: null,
      projectId: null,
      lastSeq: 0,
      lastMessagePreview: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    expect('deletedAt' in created).toBe(false);

    expect(
      service.create({
        agentId: 'agent-different',
        agentName: 'Different',
        requestId: 'request-01',
        title: 'Do not overwrite',
        owningIssueId: 'issue-different',
      }),
    ).toEqual(created);
    service.close();
  });

  it('paginates equal updatedAt values by descending id without loss', () => {
    const ids = [
      '00000000-0000-4000-8000-000000000003',
      '00000000-0000-4000-8000-000000000002',
      '00000000-0000-4000-8000-000000000001',
    ];
    let index = 0;
    const service = new SqliteConversationService({
      dataDir: tmpDir,
      now: () => '2026-07-12T00:00:00.000Z',
      uuid: () => ids[index++],
    });
    for (const requestId of ['request-3', 'request-2', 'request-1']) {
      service.create({ agentId: 'agent-01', agentName: 'Helper', requestId });
    }
    const first = service.list({ limit: 2 });
    const second = service.list({ limit: 2, cursor: first.nextCursor ?? undefined });
    expect(first.items.map((item) => item.id)).toEqual(ids.slice(0, 2));
    expect(second.items.map((item) => item.id)).toEqual(ids.slice(2));
    expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(3);
    service.close();
  });

  it('filters lists by agent and excludes tombstones', () => {
    const ids = [
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
      '00000000-0000-4000-8000-000000000003',
    ];
    let index = 0;
    const service = new SqliteConversationService({
      dataDir: tmpDir,
      now: () => '2026-07-12T00:00:00.000Z',
      uuid: () => ids[index++],
    });
    service.create({ agentId: 'agent-a', agentName: 'A', requestId: 'request-1' });
    const deleted = service.create({
      agentId: 'agent-a',
      agentName: 'A',
      requestId: 'request-2',
    });
    service.create({ agentId: 'agent-b', agentName: 'B', requestId: 'request-3' });
    service.delete(deleted.id, deleted.revision);

    expect(service.list({ agentId: 'agent-a', limit: 10 }).items.map((item) => item.id)).toEqual([
      ids[0],
    ]);
    expect(service.list({ limit: 10 }).items.map((item) => item.id)).toEqual([ids[2], ids[0]]);
    service.close();
  });

  it('updates linkage at the current revision and returns current state on stale writes', () => {
    let timestamp = '2026-07-12T00:00:00.000Z';
    const service = new SqliteConversationService({
      dataDir: tmpDir,
      now: () => timestamp,
      uuid: () => '00000000-0000-4000-8000-000000000001',
    });
    const created = service.create({
      agentId: 'agent-01',
      agentName: 'Helper',
      requestId: 'request-01',
    });
    timestamp = '2026-07-12T00:00:01.000Z';

    const updated = service.update(created.id, 1, {
      title: '  Renamed  ',
      owningIssueId: 'issue-01',
      projectId: null,
    });

    expect(updated).toMatchObject({
      title: 'Renamed',
      owningIssueId: 'issue-01',
      projectId: null,
      revision: 2,
      updatedAt: timestamp,
    });
    expect(() => service.update(created.id, 1, { title: 'Stale' })).toThrowError(
      expect.objectContaining({
        code: 'revision_conflict',
        status: 409,
        retryable: false,
        details: { current: updated },
      }),
    );
    service.close();
  });

  it('rejects empty patches, blank titles, and updates to archived or deleted rows', () => {
    const service = new SqliteConversationService({
      dataDir: tmpDir,
      now: () => '2026-07-12T00:00:00.000Z',
      uuid: () => '00000000-0000-4000-8000-000000000001',
    });
    const created = service.create({
      agentId: 'agent-01',
      agentName: 'Helper',
      requestId: 'request-01',
    });
    expect(() => service.update(created.id, 1, {})).toThrowError(ConversationServiceError);
    expect(() => service.update(created.id, 1, { title: '   ' })).toThrowError(
      ConversationServiceError,
    );

    const db = (service as unknown as { db: DatabaseType }).db;
    db.prepare("UPDATE conversations SET status = 'archived' WHERE id = ?").run(created.id);
    expect(() => service.update(created.id, 1, { title: 'Nope' })).toThrowError(
      ConversationServiceError,
    );
    service.eventLog.append('agent-01', created.id, 'turn-archived', {
      type: 'event',
      event: { type: 'text_delta', text: 'preserved' },
    });
    expect(() => service.delete(created.id, 1)).toThrowError(
      expect.objectContaining({
        code: 'validation_failed',
        status: 409,
        retryable: false,
      }),
    );
    expect(service.get(created.id)).toMatchObject({ status: 'archived', revision: 1 });
    expect(service.eventLog.readSince('agent-01', created.id, 0)).toHaveLength(1);
    db.prepare("UPDATE conversations SET status = 'idle' WHERE id = ?").run(created.id);
    service.delete(created.id, 1);
    expect(() => service.update(created.id, 2, { title: 'Nope' })).toThrowError(
      ConversationServiceError,
    );
    service.close();
  });

  it('rejects a stale delete revision without changing the conversation', () => {
    const service = new SqliteConversationService({
      dataDir: tmpDir,
      now: () => '2026-07-12T00:00:00.000Z',
      uuid: () => '00000000-0000-4000-8000-000000000001',
    });
    const created = service.create({
      agentId: 'agent-01',
      agentName: 'Helper',
      requestId: 'request-01',
    });

    expect(() => service.delete(created.id, 0)).toThrowError(
      expect.objectContaining({
        code: 'revision_conflict',
        status: 409,
        details: { current: created },
      }),
    );
    expect(service.get(created.id)).toEqual(created);
    service.close();
  });

  it('purges messages and events while retaining an opt-in tombstone', () => {
    let timestamp = '2026-07-12T00:00:00.000Z';
    const service = new SqliteConversationService({
      dataDir: tmpDir,
      now: () => timestamp,
      uuid: () => '00000000-0000-4000-8000-000000000001',
    });
    const created = service.create({
      agentId: 'agent-01',
      agentName: 'Helper',
      requestId: 'request-01',
    });
    const db = (service as unknown as { db: DatabaseType }).db;
    db.prepare('UPDATE conversations SET last_seq = 3 WHERE id = ?').run(created.id);
    db.prepare(`
      INSERT INTO conversation_messages
        (id, conversation_id, turn_id, ordinal, role, content, status, created_at, updated_at)
      VALUES (?, ?, ?, 1, 'user', ?, 'completed', ?, ?)
    `).run(
      '00000000-0000-4000-8000-000000000002',
      created.id,
      '00000000-0000-4000-8000-000000000003',
      JSON.stringify({ type: 'user', text: 'hello' }),
      timestamp,
      timestamp,
    );
    service.eventLog.append('agent-01', created.id, 'turn-01', {
      type: 'event',
      event: { type: 'text_delta', text: 'hello' },
    });
    timestamp = '2026-07-12T00:00:02.000Z';

    const tombstone = service.delete(created.id, 1);

    expect(tombstone).toMatchObject({
      id: created.id,
      status: 'deleted',
      revision: 2,
      activeTurnId: null,
      lastSeq: 3,
      updatedAt: timestamp,
      deletedAt: timestamp,
    });
    expect(service.get(created.id)).toBeNull();
    expect(service.get(created.id, { includeDeleted: true })).toEqual(tombstone);
    expect(db.prepare('SELECT COUNT(*) AS count FROM conversation_messages').get()).toEqual({
      count: 0,
    });
    expect(service.eventLog.readSince('agent-01', created.id, 0)).toEqual([]);
    service.close();
  });

  it('rejects a busy delete before revision comparison and preserves the turn', () => {
    const service = new SqliteConversationService({
      dataDir: tmpDir,
      uuid: () => '00000000-0000-4000-8000-000000000001',
    });
    const created = service.create({
      agentId: 'agent-01',
      agentName: 'Helper',
      requestId: 'request-01',
    });
    const db = (service as unknown as { db: DatabaseType }).db;
    db.prepare(
      "UPDATE conversations SET status = 'running', active_turn_id = 'turn-active' WHERE id = ?",
    ).run(created.id);
    service.eventLog.append('agent-01', created.id, 'turn-active', {
      type: 'event',
      event: { type: 'text_delta', text: 'still running' },
    });

    expect(() => service.delete(created.id, 0)).toThrowError(
      expect.objectContaining({
        code: 'conversation_busy',
        status: 409,
        details: { activeTurnId: 'turn-active' },
      }),
    );
    expect(service.get(created.id)).toMatchObject({
      status: 'running',
      activeTurnId: 'turn-active',
      revision: 1,
    });
    expect(service.eventLog.readSince('agent-01', created.id, 0)).toHaveLength(1);
    service.close();
  });

  it('pages newest messages backward while returning each page chronologically', () => {
    const service = new SqliteConversationService({
      dataDir: tmpDir,
      now: () => '2026-07-12T00:00:00.000Z',
      uuid: () => '00000000-0000-4000-8000-000000000001',
    });
    const created = service.create({
      agentId: 'agent-01',
      agentName: 'Helper',
      requestId: 'request-01',
    });
    const db = (service as unknown as { db: DatabaseType }).db;
    db.prepare('UPDATE conversations SET last_seq = 9 WHERE id = ?').run(created.id);
    const insert = db.prepare(`
      INSERT INTO conversation_messages
        (id, conversation_id, turn_id, ordinal, role, content, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'user', ?, 'completed', ?, ?)
    `);
    for (let ordinal = 1; ordinal <= 5; ordinal++) {
      const suffix = String(ordinal).padStart(12, '0');
      insert.run(
        `00000000-0000-4000-8000-${suffix}`,
        created.id,
        `10000000-0000-4000-8000-${suffix}`,
        ordinal,
        JSON.stringify({ type: 'user', text: `Message ${ordinal}` }),
        `2026-07-12T00:00:0${ordinal}.000Z`,
        `2026-07-12T00:00:0${ordinal}.000Z`,
      );
    }

    const first = service.listMessages({ conversationId: created.id, limit: 2 });
    const second = service.listMessages({
      conversationId: created.id,
      limit: 2,
      before: first.nextCursor ?? undefined,
    });

    expect(first.items.map((item) => item.ordinal)).toEqual([4, 5]);
    expect(second.items.map((item) => item.ordinal)).toEqual([2, 3]);
    expect(first.throughSeq).toBe(9);
    expect(second.throughSeq).toBe(9);
    expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(4);
    service.close();
  });

  it('assembles assistant transcript events and computes the newest user preview', () => {
    const service = new SqliteConversationService({
      dataDir: tmpDir,
      now: () => '2026-07-12T00:00:00.000Z',
      uuid: () => '00000000-0000-4000-8000-000000000001',
    });
    const created = service.create({
      agentId: 'agent-01',
      agentName: 'Helper',
      requestId: 'request-01',
    });
    const db = (service as unknown as { db: DatabaseType }).db;
    const turnId = '00000000-0000-4000-8000-000000000010';
    const userText = `  hello \n world   ${'🙂'.repeat(120)}`;
    const insert = db.prepare(`
      INSERT INTO conversation_messages
        (id, conversation_id, turn_id, ordinal, role, content, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'completed', ?, ?)
    `);
    insert.run(
      '00000000-0000-4000-8000-000000000011',
      created.id,
      turnId,
      1,
      'user',
      JSON.stringify({ type: 'user', text: userText }),
      '2026-07-12T00:00:01.000Z',
      '2026-07-12T00:00:01.000Z',
    );
    insert.run(
      '00000000-0000-4000-8000-000000000012',
      created.id,
      turnId,
      2,
      'assistant',
      JSON.stringify({ type: 'assistant', events: [{ type: 'must_not_survive' }] }),
      '2026-07-12T00:00:02.000Z',
      '2026-07-12T00:00:02.000Z',
    );
    service.eventLog.append('agent-01', created.id, turnId, {
      type: 'accepted',
      userMessageId: '00000000-0000-4000-8000-000000000011',
      assistantMessageId: '00000000-0000-4000-8000-000000000012',
      revision: 1,
    });
    service.eventLog.append('agent-01', created.id, turnId, {
      type: 'event',
      event: { type: 'text_delta', text: 'Hi' },
    });
    service.eventLog.append('agent-01', created.id, turnId, {
      type: 'done',
      outcome: 'completed',
    });

    const page = service.listMessages({ conversationId: created.id, limit: 10 });
    expect(page.items[1].content).toEqual({
      type: 'assistant',
      events: [{ type: 'text_delta', text: 'Hi' }],
    });
    const expectedPreview = [...userText.trim().replace(/\s+/g, ' ')].slice(0, 120).join('');
    expect(service.get(created.id)?.lastMessagePreview).toBe(expectedPreview);
    expect([...(service.get(created.id)?.lastMessagePreview ?? '')]).toHaveLength(120);
    service.close();
  });
});

describe('SqliteConversationService durable turns', () => {
  let tmpDir: string;
  let service: SqliteConversationService;
  let uuidCounter: number;
  let timestamp: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'conversation-turns-'));
    uuidCounter = 0;
    timestamp = '2026-07-12T01:00:00.000Z';
    service = new SqliteConversationService({
      dataDir: tmpDir,
      now: () => timestamp,
      uuid: () => `00000000-0000-4000-8000-${String(++uuidCounter).padStart(12, '0')}`,
    });
  });

  afterEach(async () => {
    service.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  function createConversation(requestId = 'create-01', agentId = 'agent-01') {
    return service.create({
      agentId,
      agentName: `Helper ${agentId}`,
      requestId,
    });
  }

  it('accepts a turn atomically with a durable lease, messages, and accepted journal entry', () => {
    const conversation = createConversation();
    timestamp = '2026-07-12T01:00:01.000Z';

    const accepted = service.acceptTurn({
      agentId: 'agent-01',
      conversationId: conversation.id,
      turnId: 'turn-01',
      text: 'Hello from mobile',
      images: [{ mediaType: 'image/png', data: 'aGVsbG8=' }],
    });

    expect(accepted).toMatchObject({
      created: true,
      firstUserMessage: true,
      seq: 1,
      conversation: {
        revision: 2,
        status: 'running',
        activeTurnId: 'turn-01',
        lastSeq: 1,
        updatedAt: timestamp,
      },
      userMessage: {
        conversationId: conversation.id,
        turnId: 'turn-01',
        ordinal: 1,
        role: 'user',
        status: 'accepted',
        content: {
          type: 'user',
          text: 'Hello from mobile',
          images: [{ mediaType: 'image/png', data: 'aGVsbG8=' }],
        },
      },
      assistantMessage: {
        conversationId: conversation.id,
        turnId: 'turn-01',
        ordinal: 2,
        role: 'assistant',
        status: 'streaming',
        content: { type: 'assistant', events: [] },
      },
    });
    expect(service.eventLog.readSince('agent-01', conversation.id, 0)).toEqual([
      expect.objectContaining({
        seq: 1,
        msgId: 'turn-01',
        payload: {
          type: 'accepted',
          userMessageId: accepted.userMessage.id,
          assistantMessageId: accepted.assistantMessage.id,
          revision: 2,
        },
      }),
    ]);
    expect(service.listMessages({ conversationId: conversation.id, limit: 10 }).items).toEqual([
      accepted.userMessage,
      accepted.assistantMessage,
    ]);
  });

  it('excludes a second client while preserving idempotent retry and per-conversation leases', () => {
    const conversation = createConversation();
    const other = createConversation('create-02');
    const first = service.acceptTurn({
      agentId: 'agent-01',
      conversationId: conversation.id,
      turnId: 'turn-01',
      text: 'Hello',
    });

    const retry = service.acceptTurn({
      agentId: 'agent-01',
      conversationId: conversation.id,
      turnId: 'turn-01',
      text: 'A retry body is ignored',
    });
    expect(retry).toMatchObject({
      userMessage: { id: first.userMessage.id, content: { type: 'user', text: 'Hello' } },
      assistantMessage: { id: first.assistantMessage.id },
      seq: first.seq,
      created: false,
    });
    expect(service.listMessages({ conversationId: conversation.id, limit: 10 }).items).toHaveLength(
      2,
    );
    expect(() =>
      service.acceptTurn({
        agentId: 'agent-01',
        conversationId: conversation.id,
        turnId: 'turn-02',
        text: 'Competing turn',
      }),
    ).toThrowError(
      expect.objectContaining({
        code: 'conversation_busy',
        details: { activeTurnId: 'turn-01' },
      }),
    );

    const parallel = service.acceptTurn({
      agentId: 'agent-01',
      conversationId: other.id,
      turnId: 'turn-02',
      text: 'Independent turn',
    });
    expect(parallel.conversation).toMatchObject({ status: 'running', activeTurnId: 'turn-02' });
    expect(first.conversation).toMatchObject({ status: 'running', activeTurnId: 'turn-01' });
  });

  it('persists JSON-safe live events and refuses late events after terminal', () => {
    const conversation = createConversation();
    service.acceptTurn({
      agentId: 'agent-01',
      conversationId: conversation.id,
      turnId: 'turn-01',
      text: 'Run a tool',
    });

    const frame = service.appendTurnEvent(conversation.id, 'turn-01', {
      type: 'tool_result',
      id: 'tool-01',
      name: 'nested-errors',
      content: 'finished',
      details: {
        direct: new Error('direct failure'),
        nested: [{ reason: new Error('deep failure') }],
      },
    });
    expect(frame).toMatchObject({
      seq: 2,
      conversation: { revision: 2, lastSeq: 2, activeTurnId: 'turn-01' },
      payload: {
        type: 'event',
        event: {
          type: 'tool_result',
          details: { direct: 'direct failure', nested: [{ reason: 'deep failure' }] },
        },
      },
    });
    expect(service.eventLog.readSince('agent-01', conversation.id, 1)[0]).toMatchObject({
      seq: 2,
      payload: frame?.payload,
    });

    service.finishTurn({
      conversationId: conversation.id,
      turnId: 'turn-01',
      outcome: 'completed',
    });
    expect(
      service.appendTurnEvent(conversation.id, 'turn-01', { type: 'text_delta', text: 'late' }),
    ).toBeNull();
    expect(service.eventLog.readSince('agent-01', conversation.id, 0)).toHaveLength(3);
  });

  it.each([
    {
      outcome: 'completed' as const,
      expectedStatus: 'completed',
      expectedPayload: { type: 'done', outcome: 'completed' },
    },
    {
      outcome: 'cancelled' as const,
      expectedStatus: 'cancelled',
      expectedPayload: { type: 'done', outcome: 'cancelled' },
    },
    {
      outcome: 'failed' as const,
      expectedStatus: 'failed',
      expectedPayload: {
        type: 'error',
        error: 'Provider unavailable',
        code: 'gateway_offline',
        retryable: true,
      },
    },
  ])('finishes $outcome exactly once and releases the lease', (testCase) => {
    const conversation = createConversation(`create-${testCase.outcome}`);
    service.acceptTurn({
      agentId: 'agent-01',
      conversationId: conversation.id,
      turnId: `turn-${testCase.outcome}`,
      text: 'Hello',
    });
    const input =
      testCase.outcome === 'failed'
        ? ({
            conversationId: conversation.id,
            turnId: `turn-${testCase.outcome}`,
            outcome: 'failed' as const,
            error: 'Provider unavailable',
            code: 'gateway_offline' as const,
            retryable: true,
          } as const)
        : ({
            conversationId: conversation.id,
            turnId: `turn-${testCase.outcome}`,
            outcome: testCase.outcome,
          } as const);

    const terminal = service.finishTurn(input);
    expect(terminal).toMatchObject({
      seq: 2,
      payload: testCase.expectedPayload,
      conversation: { status: 'idle', activeTurnId: null, revision: 3, lastSeq: 2 },
    });
    expect(
      service.listMessages({ conversationId: conversation.id, limit: 10 }).items[1],
    ).toMatchObject({ status: testCase.expectedStatus });

    const retry = service.finishTurn(input);
    expect(retry).toEqual(terminal);
    expect(service.eventLog.readSince('agent-01', conversation.id, 0)).toHaveLength(2);
  });

  it('recovers a partial turn once while preserving its accepted content and events', () => {
    const conversation = createConversation();
    service.acceptTurn({
      agentId: 'agent-01',
      conversationId: conversation.id,
      turnId: 'turn-01',
      text: 'Keep my partial response',
    });
    service.appendTurnEvent(conversation.id, 'turn-01', {
      type: 'text_delta',
      text: 'Partial answer',
    });
    service.close();
    service = new SqliteConversationService({ dataDir: tmpDir, now: () => timestamp });

    expect(service.recoverInterruptedTurns()).toEqual({
      conversationsInterrupted: 1,
      terminalsAppended: 1,
    });
    expect(service.get(conversation.id)).toMatchObject({
      status: 'interrupted',
      activeTurnId: null,
      revision: 3,
      lastSeq: 3,
    });
    expect(service.listMessages({ conversationId: conversation.id, limit: 10 }).items).toEqual([
      expect.objectContaining({ role: 'user', status: 'accepted' }),
      expect.objectContaining({
        role: 'assistant',
        status: 'interrupted',
        content: {
          type: 'assistant',
          events: [{ type: 'text_delta', text: 'Partial answer' }],
        },
      }),
    ]);
    expect(service.eventLog.readSince('agent-01', conversation.id, 2)).toEqual([
      expect.objectContaining({
        seq: 3,
        payload: {
          type: 'error',
          error: 'Gateway restarted while this turn was in progress.',
          code: 'gateway_offline',
          retryable: true,
        },
      }),
    ]);
    expect(service.recoverInterruptedTurns()).toEqual({
      conversationsInterrupted: 0,
      terminalsAppended: 0,
    });
  });

  it('sets an automatic title only while the exact default title is still present', () => {
    const automatic = createConversation('create-auto');
    const changed = service.trySetAutoTitle(automatic.id, '  First useful question  ');
    expect(changed).toMatchObject({ title: 'First useful question', revision: 2 });
    expect(service.trySetAutoTitle(automatic.id, 'A later guess')).toBeNull();

    const manual = createConversation('create-manual');
    service.update(manual.id, 1, { title: 'Manual title' });
    expect(service.trySetAutoTitle(manual.id, 'Automatic title')).toBeNull();
    expect(service.get(manual.id)).toMatchObject({ title: 'Manual title', revision: 2 });
  });

  it('requires active turns to be terminal before archiving every live agent conversation', () => {
    const active = createConversation('create-active');
    const idle = createConversation('create-idle');
    const deleted = createConversation('create-deleted');
    const otherAgent = createConversation('create-other', 'agent-02');
    service.acceptTurn({
      agentId: 'agent-01',
      conversationId: active.id,
      turnId: 'turn-active',
      text: 'Preserve this',
    });
    service.delete(deleted.id, deleted.revision);

    expect(() => service.archiveAgentConversations('agent-01')).toThrowError(
      expect.objectContaining({
        code: 'conversation_busy',
        status: 409,
        retryable: false,
        details: { activeTurnId: 'turn-active' },
      }),
    );
    expect(service.get(active.id)).toMatchObject({
      status: 'running',
      activeTurnId: 'turn-active',
      revision: 2,
    });
    expect(service.get(idle.id)).toMatchObject({ status: 'idle', revision: 1 });
    expect(service.listMessages({ conversationId: active.id, limit: 10 }).items).toEqual([
      expect.objectContaining({ role: 'user', status: 'accepted' }),
      expect.objectContaining({ role: 'assistant', status: 'streaming' }),
    ]);
    expect(service.eventLog.readSince('agent-01', active.id, 0)).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ type: 'accepted' }) }),
    ]);

    service.finishTurn({
      conversationId: active.id,
      turnId: 'turn-active',
      outcome: 'cancelled',
    });
    const archived = service.archiveAgentConversations('agent-01');
    expect(archived.map((item) => item.id)).toEqual([idle.id, active.id].sort().reverse());
    expect(archived).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: active.id, status: 'archived', activeTurnId: null }),
        expect.objectContaining({ id: idle.id, status: 'archived', activeTurnId: null }),
      ]),
    );
    expect(service.listMessages({ conversationId: active.id, limit: 10 }).items).toHaveLength(2);
    expect(service.listMessages({ conversationId: active.id, limit: 10 }).items[1]).toMatchObject({
      role: 'assistant',
      status: 'cancelled',
    });
    expect(service.eventLog.readSince('agent-01', active.id, 0)).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ type: 'accepted' }) }),
      expect.objectContaining({ payload: { type: 'done', outcome: 'cancelled' } }),
    ]);
    expect(service.get(deleted.id, { includeDeleted: true })).toMatchObject({ status: 'deleted' });
    expect(service.get(otherAgent.id)).toMatchObject({ status: 'idle', revision: 1 });
    expect(() =>
      service.acceptTurn({
        agentId: 'agent-01',
        conversationId: active.id,
        turnId: 'turn-after-archive',
        text: 'Do not reopen',
      }),
    ).toThrowError(expect.objectContaining({ code: 'validation_failed' }));
  });

  it('keeps an active turn intact until cancellation releases the delete guard', () => {
    const conversation = createConversation();
    service.acceptTurn({
      agentId: 'agent-01',
      conversationId: conversation.id,
      turnId: 'turn-active',
      text: 'Do not purge this while active',
    });

    expect(() => service.delete(conversation.id, 0)).toThrowError(
      expect.objectContaining({
        code: 'conversation_busy',
        details: { activeTurnId: 'turn-active' },
      }),
    );
    expect(service.listMessages({ conversationId: conversation.id, limit: 10 }).items).toHaveLength(
      2,
    );
    expect(service.eventLog.readSince('agent-01', conversation.id, 0)).toHaveLength(1);

    const cancellation = service.finishTurn({
      conversationId: conversation.id,
      turnId: 'turn-active',
      outcome: 'cancelled',
    });
    expect(cancellation.conversation.revision).toBe(3);
    const tombstone = service.delete(conversation.id, cancellation.conversation.revision);
    expect(tombstone).toMatchObject({ status: 'deleted', revision: 4 });
    expect(service.eventLog.readSince('agent-01', conversation.id, 0)).toEqual([]);
  });
});

describe('SqliteConversationService Follow Up queue commands', () => {
  const NOW = '2026-07-12T02:00:00.000Z';
  const AGENT_ID = 'agent-queue';
  const CHANNEL_ID = 'channel-queue';
  const ACTIVE_RUN_ID = 'run-active';
  const MAX_PENDING_BYTES = 100 * 1024 * 1024;

  let tmpDir: string;
  let service: SqliteConversationService;
  let uuidCounter: number;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'conversation-queue-'));
    uuidCounter = 0;
    service = reopenService();
  });

  afterEach(async () => {
    service.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  function nextUuid(): string {
    return `20000000-0000-4000-8000-${String(++uuidCounter).padStart(12, '0')}`;
  }

  function reopenService(): SqliteConversationService {
    return new SqliteConversationService({
      dataDir: tmpDir,
      now: () => NOW,
      uuid: nextUuid,
    });
  }

  function storage(): { db: DatabaseType } {
    return service as unknown as { db: DatabaseType };
  }

  function createConversation(active = false): string {
    const conversation = service.create({
      agentId: AGENT_ID,
      agentName: 'Queue Helper',
      requestId: nextUuid(),
    });
    if (active) {
      storage()
        .db.prepare("UPDATE conversations SET status = 'running', active_turn_id = ? WHERE id = ?")
        .run(ACTIVE_RUN_ID, conversation.id);
    }
    return conversation.id;
  }

  function enqueueFollowUp(
    conversationId: string,
    overrides: Partial<EnqueueInputCommand> = {},
  ): EnqueueInputCommand {
    return {
      commandId: 'command-enqueue',
      inputId: 'input-follow-up',
      agentId: AGENT_ID,
      channelId: CHANNEL_ID,
      conversationId,
      text: 'Follow up',
      behavior: 'followUp',
      ...overrides,
    };
  }

  function enqueueSteer(
    conversationId: string,
    overrides: Partial<EnqueueInputCommand> = {},
  ): EnqueueInputCommand {
    return {
      commandId: 'command-steer',
      inputId: 'input-steer',
      agentId: AGENT_ID,
      channelId: CHANNEL_ID,
      conversationId,
      text: 'Steer here',
      behavior: 'steer',
      expectedActiveTurnId: ACTIVE_RUN_ID,
      ...overrides,
    };
  }

  function editFollowUp(
    conversationId: string,
    overrides: Partial<EditFollowUpCommand> = {},
  ): EditFollowUpCommand {
    return {
      commandId: 'command-edit',
      conversationId,
      inputId: 'input-follow-up',
      expectedRevision: 1,
      text: 'Edited follow up',
      ...overrides,
    };
  }

  function removeFollowUp(
    conversationId: string,
    overrides: Partial<RemoveFollowUpCommand> = {},
  ): RemoveFollowUpCommand {
    return {
      commandId: 'command-remove',
      conversationId,
      inputId: 'input-follow-up',
      expectedRevision: 1,
      ...overrides,
    };
  }

  function resumeFollowUps(
    conversationId: string,
    expectedQueueRevision: number,
    overrides: Partial<ResumeFollowUpsCommand> = {},
  ): ResumeFollowUpsCommand {
    return {
      commandId: 'command-resume',
      conversationId,
      expectedQueueRevision,
      ...overrides,
    };
  }

  function frameOf(result: ReturnType<SqliteConversationService['enqueueInput']>) {
    expect(result.frames).toHaveLength(1);
    return result.frames[0];
  }

  it.each(['enqueue', 'edit', 'remove', 'resume'] as const)(
    'replays the exact durable Follow Up %s command result after reopen',
    (name) => {
      const conversationId = createConversation();
      let operation: () => ReturnType<SqliteConversationService['enqueueInput']>;
      if (name === 'enqueue') {
        operation = () => service.enqueueInput(enqueueFollowUp(conversationId));
      } else {
        service.enqueueInput(enqueueFollowUp(conversationId));
        if (name === 'edit') {
          operation = () => service.editFollowUp(editFollowUp(conversationId));
        } else if (name === 'remove') {
          operation = () => service.removeFollowUp(removeFollowUp(conversationId));
        } else {
          service.pauseFollowUpsForAgentDisable(AGENT_ID);
          operation = () => service.resumeFollowUps(resumeFollowUps(conversationId, 2));
        }
      }

      const first = operation();
      service.close();
      service = reopenService();

      expect(operation()).toEqual({ ...first, replayed: true });
    },
  );

  it('keeps three Follow Up items in FIFO enqueue order', () => {
    const conversationId = createConversation();
    for (const suffix of ['a', 'b', 'c']) {
      service.enqueueInput(
        enqueueFollowUp(conversationId, {
          commandId: `command-${suffix}`,
          inputId: `input-${suffix}`,
          text: `Follow up ${suffix}`,
        }),
      );
    }

    expect(
      storage()
        .db.prepare(
          `SELECT input_id, enqueue_order, revision
           FROM conversation_pending_inputs
           WHERE conversation_id = ? AND state = 'queued'
           ORDER BY enqueue_order`,
        )
        .all(conversationId),
    ).toEqual([
      { input_id: 'input-a', enqueue_order: 1, revision: 1 },
      { input_id: 'input-b', enqueue_order: 2, revision: 1 },
      { input_id: 'input-c', enqueue_order: 3, revision: 1 },
    ]);
  });

  it('accepts identical Follow Up text under different input IDs', () => {
    const conversationId = createConversation();
    const first = service.enqueueInput(
      enqueueFollowUp(conversationId, { commandId: 'command-a', inputId: 'input-a', text: 'same' }),
    );
    const second = service.enqueueInput(
      enqueueFollowUp(conversationId, { commandId: 'command-b', inputId: 'input-b', text: 'same' }),
    );

    expect(first.frames[0]).toMatchObject({
      type: 'input_accepted',
      input: { inputId: 'input-a' },
    });
    expect(second.frames[0]).toMatchObject({
      type: 'input_accepted',
      input: { inputId: 'input-b' },
    });
  });

  it('rejects a changed command fingerprint without replacing the durable command result', () => {
    const conversationId = createConversation();
    const command = enqueueFollowUp(conversationId);
    const first = service.enqueueInput(command);
    const changed = service.enqueueInput({ ...command, text: 'A different request' });

    expect(changed).toEqual({
      replayed: false,
      frames: [
        {
          type: 'command_rejected',
          id: command.commandId,
          conversationId,
          code: 'validation_failed',
          error: 'Command ID was already used for a different request',
          retryable: false,
        },
      ],
    });
    expect(service.enqueueInput(command)).toEqual({ ...first, replayed: true });
    expect(
      storage()
        .db.prepare('SELECT COUNT(*) FROM conversation_command_results WHERE conversation_id = ?')
        .pluck()
        .get(conversationId),
    ).toBe(1);
  });

  it('journals a duplicate Follow Up input ID under another command', () => {
    const conversationId = createConversation();
    service.enqueueInput(enqueueFollowUp(conversationId));
    const duplicate = enqueueFollowUp(conversationId, {
      commandId: 'command-duplicate',
      text: 'Must not replace original',
    });

    const rejected = service.enqueueInput(duplicate);
    expect(frameOf(rejected)).toMatchObject({
      type: 'command_rejected',
      id: duplicate.commandId,
      code: 'validation_failed',
      retryable: false,
      details: {
        inputId: duplicate.inputId,
        state: 'queued',
        itemRevision: 1,
        queueRevision: 1,
        refreshRequired: true,
      },
    });
    service.close();
    service = reopenService();
    expect(service.enqueueInput(duplicate)).toEqual({ ...rejected, replayed: true });
  });

  it.each(['edit', 'remove'] as const)(
    'journals a stale Follow Up item revision for %s with compact refresh details',
    (operation) => {
      const conversationId = createConversation();
      service.enqueueInput(enqueueFollowUp(conversationId));
      const command =
        operation === 'edit'
          ? editFollowUp(conversationId, { commandId: 'stale-edit', expectedRevision: 0 })
          : removeFollowUp(conversationId, { commandId: 'stale-remove', expectedRevision: 0 });

      const result =
        operation === 'edit'
          ? service.editFollowUp(command as EditFollowUpCommand)
          : service.removeFollowUp(command as RemoveFollowUpCommand);
      expect(frameOf(result)).toMatchObject({
        type: 'command_rejected',
        code: 'revision_conflict',
        details: {
          inputId: 'input-follow-up',
          state: 'queued',
          itemRevision: 1,
          queueRevision: 1,
          refreshRequired: true,
        },
      });
      expect(Object.keys((result.frames[0] as { details: object }).details)).toEqual([
        'inputId',
        'state',
        'itemRevision',
        'queueRevision',
        'refreshRequired',
      ]);
    },
  );

  it('edits a Follow Up while preserving enqueueOrder and advancing revisions', () => {
    const conversationId = createConversation();
    service.enqueueInput(enqueueFollowUp(conversationId));

    const result = service.editFollowUp(editFollowUp(conversationId));

    expect(frameOf(result)).toMatchObject({
      type: 'input_updated',
      queueRevision: 2,
      input: {
        inputId: 'input-follow-up',
        text: 'Edited follow up',
        revision: 2,
        enqueueOrder: 1,
      },
    });
    expect(service.get(conversationId)).toMatchObject({ revision: 3 });
  });

  it('removes a middle Follow Up and closes derived presentation positions', () => {
    const conversationId = createConversation();
    for (const suffix of ['a', 'b', 'c']) {
      service.enqueueInput(
        enqueueFollowUp(conversationId, {
          commandId: `command-${suffix}`,
          inputId: `input-${suffix}`,
        }),
      );
    }

    service.removeFollowUp(
      removeFollowUp(conversationId, {
        commandId: 'remove-b',
        inputId: 'input-b',
      }),
    );
    const queued = storage()
      .db.prepare(
        `SELECT input_id, enqueue_order
         FROM conversation_pending_inputs
         WHERE conversation_id = ? AND kind = 'follow_up' AND state = 'queued'
         ORDER BY enqueue_order`,
      )
      .all(conversationId) as Array<{ input_id: string; enqueue_order: number }>;

    expect(queued.map((item, index) => [item.input_id, index + 1])).toEqual([
      ['input-a', 1],
      ['input-c', 2],
    ]);
    expect(queued.map((item) => item.enqueue_order)).toEqual([1, 3]);
  });

  it('rejects removal after a Follow Up starts delivering', () => {
    const conversationId = createConversation();
    service.enqueueInput(enqueueFollowUp(conversationId));
    storage()
      .db.prepare("UPDATE conversation_pending_inputs SET state = 'delivering' WHERE input_id = ?")
      .run('input-follow-up');

    const result = service.removeFollowUp(removeFollowUp(conversationId));

    expect(frameOf(result)).toMatchObject({
      type: 'command_rejected',
      code: 'validation_failed',
      details: {
        inputId: 'input-follow-up',
        state: 'delivering',
        itemRevision: 1,
        queueRevision: 1,
        refreshRequired: true,
      },
    });
  });

  it('enforces queue pause and resume revision CAS with compact refresh details', () => {
    const conversationId = createConversation();
    service.enqueueInput(enqueueFollowUp(conversationId));
    const paused = service.pauseFollowUpsForAgentDisable(AGENT_ID);
    expect(paused[0]).toMatchObject({
      conversation: { queuePaused: true, queueRevision: 2, revision: 3 },
      frame: { type: 'queue_paused', queueRevision: 2, pendingFollowUpCount: 1 },
    });

    const stale = service.resumeFollowUps(
      resumeFollowUps(conversationId, 1, { commandId: 'resume-stale' }),
    );
    expect(frameOf(stale)).toEqual({
      type: 'command_rejected',
      id: 'resume-stale',
      conversationId,
      code: 'revision_conflict',
      error: 'Queue revision 1 is stale',
      retryable: false,
      details: {
        queuePaused: true,
        queueRevision: 2,
        pendingFollowUpCount: 1,
        refreshRequired: true,
      },
    });
    const resumed = service.resumeFollowUps(resumeFollowUps(conversationId, 2));
    expect(resumed.promotedRun).toBeUndefined();
    expect(frameOf(resumed)).toMatchObject({
      type: 'queue_resumed',
      queueRevision: 3,
      queuePaused: false,
      pendingFollowUpCount: 1,
    });
  });

  it('removing the final queued Follow Up clears pause without promotion', () => {
    const conversationId = createConversation();
    service.enqueueInput(enqueueFollowUp(conversationId));
    service.pauseFollowUpsForAgentDisable(AGENT_ID);

    const removed = service.removeFollowUp(removeFollowUp(conversationId));

    expect(removed.promotedRun).toBeUndefined();
    expect(removed.frames.map((frame) => frame.type)).toEqual(['input_removed', 'queue_resumed']);
    expect(removed.frames).toEqual([
      expect.objectContaining({
        type: 'input_removed',
        queueRevision: 3,
        input: expect.objectContaining({ state: 'removed', revision: 2 }),
      }),
      expect.objectContaining({
        type: 'queue_resumed',
        queueRevision: 3,
        queuePaused: false,
        pendingFollowUpCount: 0,
      }),
    ]);
    expect(
      storage()
        .db.prepare('SELECT queue_paused, queue_revision FROM conversations WHERE id = ?')
        .get(conversationId),
    ).toEqual({ queue_paused: 0, queue_revision: 3 });
  });

  it('rejects the 21st Steer admission at the per-kind queue limit', () => {
    const conversationId = createConversation(true);
    for (let index = 1; index <= 20; index++) {
      expect(
        frameOf(
          service.enqueueInput(
            enqueueSteer(conversationId, {
              commandId: `steer-command-${index}`,
              inputId: `steer-input-${index}`,
            }),
          ),
        ),
      ).toMatchObject({ type: 'input_accepted' });
    }

    const rejected = service.enqueueInput(
      enqueueSteer(conversationId, { commandId: 'steer-command-21', inputId: 'steer-input-21' }),
    );
    expect(frameOf(rejected)).toMatchObject({
      type: 'command_rejected',
      code: 'validation_failed',
      retryable: false,
      details: { kind: 'steer', count: 20, limit: 20, queueRevision: 20 },
    });
    expect(
      storage()
        .db.prepare("SELECT COUNT(*) FROM conversation_pending_inputs WHERE kind = 'steer'")
        .pluck()
        .get(),
    ).toBe(20);
  });

  it('rejects the 21st Follow Up at the per-kind queue limit', () => {
    const conversationId = createConversation();
    for (let index = 1; index <= 20; index++) {
      service.enqueueInput(
        enqueueFollowUp(conversationId, {
          commandId: `follow-up-command-${index}`,
          inputId: `follow-up-input-${index}`,
        }),
      );
    }

    const rejected = service.enqueueInput(
      enqueueFollowUp(conversationId, {
        commandId: 'follow-up-command-21',
        inputId: 'follow-up-input-21',
      }),
    );
    expect(frameOf(rejected)).toMatchObject({
      type: 'command_rejected',
      code: 'validation_failed',
      details: { kind: 'follow_up', count: 20, limit: 20, queueRevision: 20 },
    });
    expect(service.get(conversationId)).toMatchObject({ revision: 21 });
  });

  it('rejects aggregate queue bytes over 100 MiB and removal frees capacity', () => {
    const conversationId = createConversation();
    service.enqueueInput(enqueueFollowUp(conversationId));
    storage()
      .db.prepare('UPDATE conversation_pending_inputs SET payload_bytes = ? WHERE input_id = ?')
      .run(MAX_PENDING_BYTES, 'input-follow-up');

    const overflow = service.enqueueInput(
      enqueueFollowUp(conversationId, {
        commandId: 'command-overflow',
        inputId: 'input-overflow',
      }),
    );
    expect(frameOf(overflow)).toMatchObject({
      type: 'command_rejected',
      code: 'validation_failed',
      details: {
        payloadBytes: expect.any(Number),
        pendingBytes: MAX_PENDING_BYTES,
        limitBytes: MAX_PENDING_BYTES,
        queueRevision: 1,
      },
    });

    service.removeFollowUp(removeFollowUp(conversationId));
    expect(
      frameOf(
        service.enqueueInput(
          enqueueFollowUp(conversationId, {
            commandId: 'command-after-remove',
            inputId: 'input-after-remove',
          }),
        ),
      ),
    ).toMatchObject({ type: 'input_accepted' });
  });

  it('round-trips Follow Up images and measures the canonical serialized payload bytes', () => {
    const conversationId = createConversation();
    const images = [{ mediaType: 'image/png' as const, data: 'b3JpZ2luYWw=' }];
    const accepted = service.enqueueInput(
      enqueueFollowUp(conversationId, { text: 'With image', images }),
    );

    expect(frameOf(accepted)).toMatchObject({
      type: 'input_accepted',
      input: { text: 'With image', images },
    });
    expect(
      storage()
        .db.prepare('SELECT images_json, payload_bytes FROM conversation_pending_inputs')
        .get(),
    ).toEqual({
      images_json: JSON.stringify(images),
      payload_bytes: Buffer.byteLength(JSON.stringify({ text: 'With image', images })),
    });
  });

  it('admits a Follow Up before a Steer without allocating Follow Up transcript ordinals', () => {
    const conversationId = createConversation(true);
    service.enqueueInput(
      enqueueFollowUp(conversationId, { commandId: 'follow-up-first', inputId: 'follow-up-first' }),
    );
    service.enqueueInput(
      enqueueSteer(conversationId, { commandId: 'steer-second', inputId: 'steer-second' }),
    );

    expect(
      storage()
        .db.prepare(
          `SELECT input_id, kind, target_turn_id, reserved_user_ordinal,
                  reserved_assistant_ordinal, enqueue_order
           FROM conversation_pending_inputs
           ORDER BY enqueue_order`,
        )
        .all(),
    ).toEqual([
      {
        input_id: 'follow-up-first',
        kind: 'follow_up',
        target_turn_id: ACTIVE_RUN_ID,
        reserved_user_ordinal: null,
        reserved_assistant_ordinal: null,
        enqueue_order: 1,
      },
      {
        input_id: 'steer-second',
        kind: 'steer',
        target_turn_id: ACTIVE_RUN_ID,
        reserved_user_ordinal: 1,
        reserved_assistant_ordinal: 2,
        enqueue_order: 2,
      },
    ]);
    expect(
      storage()
        .db.prepare(
          'SELECT ordinal, role, delivery_kind, delivery_status FROM conversation_messages',
        )
        .all(),
    ).toEqual([{ ordinal: 1, role: 'user', delivery_kind: 'steer', delivery_status: 'pending' }]);
    expect(
      storage().db.prepare('SELECT next_message_ordinal FROM conversations').pluck().get(),
    ).toBe(3);
  });

  it('replays the original command result bytes after an edit without storing content in outcome_json', () => {
    const conversationId = createConversation();
    const original = enqueueFollowUp(conversationId, {
      text: 'original private text',
      images: [{ mediaType: 'image/png', data: 'b3JpZ2luYWwtYmFzZTY0' }],
    });
    const accepted = service.enqueueInput(original);
    service.editFollowUp(
      editFollowUp(conversationId, {
        text: 'edited private text',
        images: [{ mediaType: 'image/jpeg', data: 'ZWRpdGVkLWJhc2U2NA==' }],
      }),
    );
    const outcomeJson = storage()
      .db.prepare(
        'SELECT outcome_json FROM conversation_command_results WHERE conversation_id = ? AND command_id = ?',
      )
      .pluck()
      .get(conversationId, original.commandId) as string;

    expect(JSON.parse(outcomeJson)).toEqual({ kind: 'sequenced', v2Seqs: [1] });
    for (const privateValue of [
      'original private text',
      'edited private text',
      'b3JpZ2luYWwtYmFzZTY0',
      'ZWRpdGVkLWJhc2U2NA==',
    ]) {
      expect(outcomeJson).not.toContain(privateValue);
    }
    service.close();
    service = reopenService();

    const replayed = service.enqueueInput(original);
    expect(JSON.stringify(replayed.frames[0])).toBe(JSON.stringify(accepted.frames[0]));
    expect(replayed).toEqual({ ...accepted, replayed: true });
    expect(replayed.frames[0]).toMatchObject({
      type: 'input_accepted',
      v2Seq: 1,
      input: {
        text: 'original private text',
        images: [{ mediaType: 'image/png', data: 'b3JpZ2luYWwtYmFzZTY0' }],
      },
    });
  });

  it('keeps ownership and unknown-conversation failures outside the command journal', () => {
    const conversationId = createConversation();
    expect(() =>
      service.enqueueInput(
        enqueueFollowUp(conversationId, { commandId: 'wrong-owner', agentId: 'agent-other' }),
      ),
    ).toThrowError(expect.objectContaining({ code: 'not_found' }));
    expect(() =>
      service.enqueueInput(enqueueFollowUp('missing-conversation', { commandId: 'missing' })),
    ).toThrowError(expect.objectContaining({ code: 'not_found' }));
    expect(
      storage().db.prepare('SELECT COUNT(*) FROM conversation_command_results').pluck().get(),
    ).toBe(0);
  });

  it('pauses each writable nonempty Follow Up queue once without command journaling', () => {
    const first = createConversation();
    const second = createConversation();
    service.enqueueInput(enqueueFollowUp(first, { commandId: 'enqueue-first', inputId: 'first' }));
    service.enqueueInput(
      enqueueFollowUp(second, { commandId: 'enqueue-second', inputId: 'second' }),
    );
    const commandCount = storage()
      .db.prepare('SELECT COUNT(*) FROM conversation_command_results')
      .pluck()
      .get();

    const paused = service.pauseFollowUpsForAgentDisable(AGENT_ID);

    expect(paused).toHaveLength(2);
    expect(paused.map(({ frame }) => frame.type)).toEqual(['queue_paused', 'queue_paused']);
    expect(service.pauseFollowUpsForAgentDisable(AGENT_ID)).toEqual([]);
    expect(
      storage().db.prepare('SELECT COUNT(*) FROM conversation_command_results').pluck().get(),
    ).toBe(commandCount);
  });
});
