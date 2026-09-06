import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SubagentInfo } from '@dash/mobile-contract';
import Database, { type Database as DatabaseType } from 'better-sqlite3';
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
      kind: 'user',
    });
    expect('deletedAt' in created).toBe(false);
    // A user conversation carries no child linkage at all.
    expect('parentConversationId' in created).toBe(false);
    expect('subagent' in created).toBe(false);

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

/**
 * Task C1 — the storage layer for sub-agent conversations. These tests pin the
 * four controller rulings: additive+idempotent migrations, children hidden from
 * the default `list()`, a hard cap on the notification queue, and an `origin`
 * that defaults to `'user'` so every pre-existing message row keeps its meaning.
 */
describe('SqliteConversationService subagent persistence', () => {
  let tmpDir: string;
  let service: SqliteConversationService;
  let uuidCounter: number;
  let timestamp: string;

  function subagentInfo(overrides: Partial<SubagentInfo> = {}): SubagentInfo {
    return {
      type: 'code-reviewer',
      status: 'running',
      description: 'Review the diff',
      prompt: 'Review the diff and report findings',
      model: 'anthropic/claude-opus-4',
      background: true,
      depth: 1,
      startedAt: '2026-09-04T00:00:00.000Z',
      toolCallCount: 0,
      oneShot: false,
      ...overrides,
    };
  }

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'conversation-subagents-'));
    uuidCounter = 0;
    timestamp = '2026-09-04T00:00:00.000Z';
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

  function createParent(requestId = 'parent-01') {
    return service.create({ agentId: 'agent-01', agentName: 'Helper', requestId });
  }

  it('adds the subagent columns to a pre-existing database and re-opens idempotently', async () => {
    // Ruling 1: the DB already exists in the field, so the migration has to be a
    // guarded ALTER over the *old* table shape, and opening the same file twice
    // must not attempt the ALTER again (SQLite would throw "duplicate column").
    service.close();
    const legacyDir = await mkdtemp(join(tmpdir(), 'conversation-legacy-'));
    const legacy = new Database(join(legacyDir, 'agent-stream-events.db'));
    legacy.exec(`
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
      INSERT INTO conversations VALUES (
        'conversation-legacy', 'request-legacy', 'agent-legacy', 'Legacy', 'Old chat',
        3, 'idle', NULL, NULL, NULL, 7,
        '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:01.000Z', NULL
      );
      INSERT INTO conversation_messages VALUES (
        'message-legacy', 'conversation-legacy', 'turn-legacy', 1, 'user',
        '{"type":"user","text":"legacy question"}', 'completed',
        '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'
      );
    `);
    legacy.close();

    const first = new SqliteConversationService({ dataDir: legacyDir });
    // Ruling 4: the pre-existing rows keep their meaning under the new columns.
    expect(first.get('conversation-legacy')).toMatchObject({
      kind: 'user',
      title: 'Old chat',
      revision: 3,
    });
    expect(
      first.listMessages({ conversationId: 'conversation-legacy', limit: 10 }).items[0],
    ).toMatchObject({ origin: 'user' });
    first.close();

    // Second open over the same file: the guard must skip every ALTER.
    const second = new SqliteConversationService({ dataDir: legacyDir });
    expect(second.get('conversation-legacy')).toMatchObject({ kind: 'user' });
    const db = (second as unknown as { db: DatabaseType }).db;
    const columns = (db.pragma('table_info(conversations)') as Array<{ name: string }>).map(
      (column) => column.name,
    );
    for (const added of [
      'kind',
      'parent_conversation_id',
      'parent_turn_id',
      'depth',
      'subagent_type',
      'subagent_name',
      'subagent_status',
      'subagent_meta',
    ]) {
      expect(columns.filter((name) => name === added)).toEqual([added]);
    }
    expect(
      (db.pragma('table_info(conversation_messages)') as Array<{ name: string }>).filter(
        (column) => column.name === 'origin',
      ),
    ).toHaveLength(1);
    expect(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .all('pending_notifications'),
    ).toHaveLength(1);
    second.close();
    await rm(legacyDir, { recursive: true, force: true });
  });

  it('creates a child conversation carrying its subagent info', () => {
    const parent = createParent();
    const created = service.createSubagent({
      id: 'sub_00000000000000000000000001',
      agentId: 'agent-01',
      agentName: 'Helper',
      parentConversationId: parent.id,
      parentTurnId: 'turn-parent-01',
      title: 'Review the diff',
      subagent: subagentInfo({ name: 'reviewer' }),
    });

    expect(created).toMatchObject({
      id: 'sub_00000000000000000000000001',
      kind: 'subagent',
      parentConversationId: parent.id,
      parentTurnId: 'turn-parent-01',
      title: 'Review the diff',
      status: 'idle',
      subagent: subagentInfo({ name: 'reviewer' }),
    });
    expect(service.get('sub_00000000000000000000000001')).toEqual(created);
    // Parents stay plain users with no subagent block at all.
    expect(service.get(parent.id)).toMatchObject({ kind: 'user' });
    expect('subagent' in (service.get(parent.id) as object)).toBe(false);
  });

  it('hides children from the default list and reveals them only on request', () => {
    // Ruling 2: a child's prompt can quote parent context, so the default list
    // is user-only for privacy, not just for tidiness.
    const parent = createParent();
    service.createSubagent({
      id: 'sub_child_a',
      agentId: 'agent-01',
      agentName: 'Helper',
      parentConversationId: parent.id,
      parentTurnId: 'turn-parent-01',
      title: 'Child A',
      subagent: subagentInfo(),
    });

    expect(service.list({ limit: 10 }).items.map((item) => item.id)).toEqual([parent.id]);
    expect(service.list({ agentId: 'agent-01', limit: 10 }).items.map((item) => item.id)).toEqual([
      parent.id,
    ]);
    expect(service.list({ limit: 10, kind: 'user' }).items.map((item) => item.id)).toEqual([
      parent.id,
    ]);
    expect(service.list({ limit: 10, kind: 'subagent' }).items.map((item) => item.id)).toEqual([
      'sub_child_a',
    ]);
  });

  it('lists a parent-s children oldest first', () => {
    const parent = createParent();
    const other = createParent('parent-02');
    for (const [index, id] of ['sub_c1', 'sub_c2', 'sub_c3'].entries()) {
      timestamp = `2026-09-04T00:0${index}:00.000Z`;
      service.createSubagent({
        id,
        agentId: 'agent-01',
        agentName: 'Helper',
        parentConversationId: parent.id,
        parentTurnId: 'turn-parent-01',
        title: id,
        subagent: subagentInfo(),
      });
    }
    timestamp = '2026-09-04T00:09:00.000Z';
    service.createSubagent({
      id: 'sub_other',
      agentId: 'agent-01',
      agentName: 'Helper',
      parentConversationId: other.id,
      parentTurnId: 'turn-parent-02',
      title: 'Other',
      subagent: subagentInfo(),
    });

    expect(service.listSubagents(parent.id).map((item) => item.id)).toEqual([
      'sub_c1',
      'sub_c2',
      'sub_c3',
    ]);
    expect(service.listSubagents(other.id).map((item) => item.id)).toEqual(['sub_other']);
    expect(service.listSubagents('missing-parent')).toEqual([]);
  });

  it('bounds listSubagents to the NEWEST children, still oldest-first', () => {
    const parent = createParent();
    for (let i = 0; i < 5; i++) {
      service.createSubagent({
        id: `sub_page${i}`,
        agentId: 'agent-01',
        agentName: 'Helper',
        parentConversationId: parent.id,
        parentTurnId: 'turn-parent-01',
        title: `Child ${i}`,
        subagent: subagentInfo(),
      });
    }

    // Every row read parses that child's whole `subagent_meta` — its report
    // included — and the sub-agent registry reads this per parent turn, so an
    // unbounded SELECT * grows with the age of a conversation.
    expect(service.listSubagents(parent.id, 2).map((item) => item.id)).toEqual([
      'sub_page3',
      'sub_page4',
    ]);
    expect(service.listSubagents(parent.id, 0)).toEqual([]);
    expect(service.listSubagents(parent.id).map((item) => item.id)).toHaveLength(5);
  });

  it('merges a subagent patch without dropping the untouched fields', () => {
    const parent = createParent();
    service.createSubagent({
      id: 'sub_patch',
      agentId: 'agent-01',
      agentName: 'Helper',
      parentConversationId: parent.id,
      parentTurnId: 'turn-parent-01',
      title: 'Patch me',
      subagent: subagentInfo(),
    });

    const patched = service.updateSubagent('sub_patch', {
      status: 'done',
      info: {
        toolCallCount: 4,
        endedAt: '2026-09-04T00:05:00.000Z',
        usage: { inputTokens: 120, outputTokens: 34 },
        report: 'Found two issues.',
      },
    });
    expect(patched.subagent).toEqual({
      ...subagentInfo(),
      status: 'done',
      toolCallCount: 4,
      endedAt: '2026-09-04T00:05:00.000Z',
      usage: { inputTokens: 120, outputTokens: 34 },
      report: 'Found two issues.',
    });
    expect(service.get('sub_patch')).toEqual(patched);
    expect(() => service.updateSubagent(parent.id, { status: 'done' })).toThrow(
      ConversationServiceError,
    );
  });

  it('lists only the interrupted children', () => {
    const parent = createParent();
    for (const [id, status] of [
      ['sub_running', 'running'],
      ['sub_interrupted_a', 'interrupted'],
      ['sub_interrupted_b', 'interrupted'],
    ] as const) {
      service.createSubagent({
        id,
        agentId: 'agent-01',
        agentName: 'Helper',
        parentConversationId: parent.id,
        parentTurnId: 'turn-parent-01',
        title: id,
        subagent: subagentInfo({ status }),
      });
    }
    expect(service.listInterruptedSubagents().map((item) => item.id)).toEqual([
      'sub_interrupted_a',
      'sub_interrupted_b',
    ]);
  });

  it('records the turn origin on the user message and defaults it to user', () => {
    // Ruling 4: `origin` is optional at the call site and defaults to 'user'.
    const parent = createParent();
    service.acceptTurn({
      agentId: 'agent-01',
      conversationId: parent.id,
      turnId: 'turn-plain',
      text: 'Plain user turn',
    });
    service.finishTurn({
      conversationId: parent.id,
      turnId: 'turn-plain',
      outcome: 'completed',
    });
    const notified = service.acceptTurn({
      agentId: 'agent-01',
      conversationId: parent.id,
      turnId: 'turn-notified',
      text: '<subagent-finished .../>',
      origin: 'notification',
    });

    expect(notified.userMessage.origin).toBe('notification');
    // The origin describes the TURN, so both rows carry it: listMessages pages
    // by ordinal and a page boundary can put the two rows of one turn on
    // different pages, leaving an assistant-only page unable to recover it.
    expect(notified.assistantMessage.origin).toBe('notification');
    expect(
      service
        .listMessages({ conversationId: parent.id, limit: 10 })
        .items.map((message) => [message.role, message.origin]),
    ).toEqual([
      ['user', 'user'],
      ['assistant', 'user'],
      ['user', 'notification'],
      ['assistant', 'notification'],
    ]);
    // A single-row page still carries the origin.
    const lastPage = service.listMessages({ conversationId: parent.id, limit: 1 });
    expect(lastPage.items).toEqual([
      expect.objectContaining({ role: 'assistant', origin: 'notification' }),
    ]);
  });

  it('exposes children through the parentConversationId filter', () => {
    const parent = createParent();
    const other = createParent('parent-02');
    service.createSubagent({
      id: 'sub_filter_a',
      agentId: 'agent-01',
      agentName: 'Helper',
      parentConversationId: parent.id,
      parentTurnId: 'turn-parent-01',
      title: 'Mine',
      subagent: subagentInfo(),
    });
    service.createSubagent({
      id: 'sub_filter_b',
      agentId: 'agent-01',
      agentName: 'Helper',
      parentConversationId: other.id,
      parentTurnId: 'turn-parent-02',
      title: 'Theirs',
      subagent: subagentInfo(),
    });

    expect(
      service
        .list({ limit: 10, kind: 'subagent', parentConversationId: parent.id })
        .items.map((item) => item.id),
    ).toEqual(['sub_filter_a']);
    // The trap worth a test: kind still defaults to 'user', and no parent has a
    // parent, so the filter alone returns nothing.
    expect(service.list({ limit: 10, parentConversationId: parent.id }).items).toEqual([]);
  });

  it('tombstones the whole subtree when a parent is deleted', () => {
    const parent = createParent();
    const child = service.createSubagent({
      id: 'sub_level_one',
      agentId: 'agent-01',
      agentName: 'Helper',
      parentConversationId: parent.id,
      parentTurnId: 'turn-parent-01',
      title: 'Level one',
      subagent: subagentInfo(),
    });
    service.createSubagent({
      id: 'sub_level_two',
      agentId: 'agent-01',
      agentName: 'Helper',
      parentConversationId: child.id,
      parentTurnId: 'turn-child-01',
      title: 'Level two',
      subagent: subagentInfo({ depth: 2 }),
    });
    const bystander = createParent('parent-02');
    service.createSubagent({
      id: 'sub_bystander',
      agentId: 'agent-01',
      agentName: 'Helper',
      parentConversationId: bystander.id,
      parentTurnId: 'turn-parent-02',
      title: 'Untouched',
      subagent: subagentInfo(),
    });
    service.acceptTurn({
      agentId: 'agent-01',
      conversationId: 'sub_level_two',
      turnId: 'turn-grandchild-01',
      text: 'Working',
      origin: 'parent',
    });

    service.delete(parent.id, parent.revision);

    // A grandchild's prompt can quote the context the user just deleted, so the
    // whole subtree goes, not just the direct children.
    for (const id of ['sub_level_one', 'sub_level_two']) {
      expect(service.get(id)).toBeNull();
      expect(service.get(id, { includeDeleted: true })).toMatchObject({ status: 'deleted' });
    }
    expect(service.listSubagents(parent.id)).toEqual([]);
    expect(service.list({ limit: 10, kind: 'subagent' }).items.map((item) => item.id)).toEqual([
      'sub_bystander',
    ]);
    // Transcripts and event logs of the subtree are gone, and an active child
    // turn does not save it.
    expect(
      (service as unknown as { db: DatabaseType }).db
        .prepare('SELECT COUNT(*) AS total FROM conversation_messages WHERE conversation_id = ?')
        .get('sub_level_two'),
    ).toEqual({ total: 0 });
    expect(service.eventLog.readSince('agent-01', 'sub_level_two', 0)).toEqual([]);
    expect(service.get('sub_level_two', { includeDeleted: true })?.activeTurnId).toBeNull();
    // The bystander subtree is untouched.
    expect(service.get('sub_bystander')).toMatchObject({ status: 'idle' });
  });

  it('queues notifications up to the cap and drains them in order', () => {
    // Ruling 3: overflow throws — a dropped notification is a lost child report.
    const parent = createParent();
    for (let index = 0; index < 100; index++) {
      service.enqueueNotification({
        conversationId: parent.id,
        kind: 'subagent_finished',
        payload: { index },
      });
    }
    expect(() =>
      service.enqueueNotification({
        conversationId: parent.id,
        kind: 'subagent_finished',
        payload: { index: 100 },
      }),
    ).toThrow(/notification queue full/i);

    const drained = service.drainNotifications(parent.id);
    expect(drained).toHaveLength(100);
    expect(drained.map((item) => item.payload.index)).toEqual(
      Array.from({ length: 100 }, (_unused, index) => index),
    );
    expect(drained[0]).toMatchObject({
      conversationId: parent.id,
      kind: 'subagent_finished',
      createdAt: timestamp,
    });
    expect(service.drainNotifications(parent.id)).toEqual([]);
    // Draining frees the queue again.
    expect(() =>
      service.enqueueNotification({
        conversationId: parent.id,
        kind: 'subagent_message',
        payload: { text: 'hi' },
      }),
    ).not.toThrow();
    expect(service.drainNotifications(parent.id)).toHaveLength(1);
  });

  it('peeks WITHOUT removing, and acks only the ids it is given', () => {
    const parent = createParent();
    const first = service.enqueueNotification({
      conversationId: parent.id,
      kind: 'subagent_finished',
      payload: { index: 0 },
    });
    const second = service.enqueueNotification({
      conversationId: parent.id,
      kind: 'subagent_finished',
      payload: { index: 1 },
    });

    // Repeated peeks are idempotent: a failed delivery leaves the queue exactly
    // as it found it, so nothing is lost if the process dies mid-attempt and
    // no row's created_at is re-stamped (which would reorder the queue).
    expect(service.peekNotifications(parent.id).map((item) => item.id)).toEqual([
      first.id,
      second.id,
    ]);
    expect(service.peekNotifications(parent.id).map((item) => item.id)).toEqual([
      first.id,
      second.id,
    ]);

    service.ackNotifications([first.id]);
    expect(service.peekNotifications(parent.id).map((item) => item.id)).toEqual([second.id]);

    // A row enqueued after the ack still sorts AFTER the survivor.
    const third = service.enqueueNotification({
      conversationId: parent.id,
      kind: 'subagent_message',
      payload: { from: 'scout' },
    });
    expect(service.peekNotifications(parent.id).map((item) => item.id)).toEqual([
      second.id,
      third.id,
    ]);

    // Unknown ids are ignored, and an empty ack is a no-op.
    service.ackNotifications([]);
    service.ackNotifications(['not-a-row', second.id, third.id]);
    expect(service.peekNotifications(parent.id)).toEqual([]);
  });

  it('drops a deleted conversation-s queue and refuses to enqueue behind the tombstone', () => {
    const parent = createParent();
    service.enqueueNotification({
      conversationId: parent.id,
      kind: 'subagent_finished',
      payload: { index: 0 },
    });
    const tombstone = service.delete(parent.id, parent.revision);
    expect(tombstone.status).toBe('deleted');
    expect(service.drainNotifications(parent.id)).toEqual([]);
    expect(() =>
      service.enqueueNotification({
        conversationId: parent.id,
        kind: 'subagent_finished',
        payload: {},
      }),
    ).toThrow(ConversationServiceError);
  });

  it('refuses to update a deleted child or to alias a non-subagent id', () => {
    const parent = createParent();
    const child = service.createSubagent({
      id: 'sub_guard',
      agentId: 'agent-01',
      agentName: 'Helper',
      parentConversationId: parent.id,
      parentTurnId: 'turn-parent-01',
      title: 'Guarded',
      subagent: subagentInfo(),
    });
    // createSubagent is idempotent on its own id...
    expect(
      service.createSubagent({
        id: 'sub_guard',
        agentId: 'agent-01',
        agentName: 'Helper',
        parentConversationId: parent.id,
        parentTurnId: 'turn-parent-01',
        title: 'Different title',
        subagent: subagentInfo({ status: 'done' }),
      }),
    ).toEqual(child);
    // ...but it must never hand back a user conversation that shares the id.
    expect(() =>
      service.createSubagent({
        id: parent.id,
        agentId: 'agent-01',
        agentName: 'Helper',
        parentConversationId: parent.id,
        parentTurnId: 'turn-parent-01',
        title: 'Impostor',
        subagent: subagentInfo(),
      }),
    ).toThrow(ConversationServiceError);

    service.delete(child.id, child.revision);
    expect(() => service.updateSubagent(child.id, { status: 'done' })).toThrow(
      ConversationServiceError,
    );
    // A tombstone lives forever, so the idempotence branch must not report a
    // deleted child as a fresh spawn — the caller's first acceptTurn would then
    // fail with not_found on a conversation it believes it just created.
    expect(() =>
      service.createSubagent({
        id: 'sub_guard',
        agentId: 'agent-01',
        agentName: 'Helper',
        parentConversationId: parent.id,
        parentTurnId: 'turn-parent-01',
        title: 'Respawn',
        subagent: subagentInfo(),
      }),
    ).toThrow(expect.objectContaining({ code: 'not_found', status: 410 }));
  });

  it('fails loudly on a corrupt child row instead of inventing contract-invalid values', () => {
    const parent = createParent();
    service.createSubagent({
      id: 'sub_corrupt',
      agentId: 'agent-01',
      agentName: 'Helper',
      parentConversationId: parent.id,
      parentTurnId: 'turn-parent-01',
      title: 'Corrupt me',
      subagent: subagentInfo(),
    });
    const db = (service as unknown as { db: DatabaseType }).db;

    // `SubagentInfo.type` is `minLength: 1` in the contract, so defaulting to ''
    // would mint a summary the contract suite itself rejects.
    db.prepare('UPDATE conversations SET subagent_type = NULL WHERE id = ?').run('sub_corrupt');
    expect(() => service.get('sub_corrupt')).toThrow(/no subagent_type/);

    db.prepare(
      "UPDATE conversations SET subagent_type = 'x', subagent_status = NULL WHERE id = ?",
    ).run('sub_corrupt');
    expect(() => service.get('sub_corrupt')).toThrow(/no subagent_status/);
  });

  it('keeps each conversation-s notification queue separate', () => {
    const first = createParent('parent-01');
    const second = createParent('parent-02');
    service.enqueueNotification({
      conversationId: first.id,
      kind: 'subagent_finished',
      payload: { from: 'first' },
    });
    service.enqueueNotification({
      conversationId: second.id,
      kind: 'subagent_message',
      payload: { from: 'second' },
    });
    expect(service.drainNotifications(first.id).map((item) => item.payload.from)).toEqual([
      'first',
    ]);
    expect(service.drainNotifications(second.id).map((item) => item.payload.from)).toEqual([
      'second',
    ]);
  });
});
