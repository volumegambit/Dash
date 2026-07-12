import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
      event: { type: 'text_delta', delta: 'hello' },
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
      event: { type: 'text_delta', delta: 'still running' },
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
      event: { type: 'text_delta', delta: 'Hi' },
    });
    service.eventLog.append('agent-01', created.id, turnId, {
      type: 'done',
      outcome: 'completed',
    });

    const page = service.listMessages({ conversationId: created.id, limit: 10 });
    expect(page.items[1].content).toEqual({
      type: 'assistant',
      events: [{ type: 'text_delta', delta: 'Hi' }],
    });
    const expectedPreview = [...userText.trim().replace(/\s+/g, ' ')].slice(0, 120).join('');
    expect(service.get(created.id)?.lastMessagePreview).toBe(expectedPreview);
    expect([...(service.get(created.id)?.lastMessagePreview ?? '')]).toHaveLength(120);
    service.close();
  });
});
