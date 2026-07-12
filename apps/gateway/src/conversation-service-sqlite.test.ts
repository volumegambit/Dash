import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { SqliteConversationService } from './conversation-service-sqlite.js';

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

    const serviceDb = (service as unknown as { db: Database.Database }).db;
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
});
