import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteEventLogStore } from './event-log-store-sqlite.js';
import type { EventLogPayload } from './event-log-store.js';

/**
 * Cover the contract of the `EventLogStore` interface against the
 * SQLite adapter. These tests assert behaviour, not storage layout —
 * when we add a second adapter (LMDB, Postgres, whatever), we should
 * be able to point the same test suite at it and pass.
 */
describe('SqliteEventLogStore', () => {
  let tmpDir: string;
  let store: SqliteEventLogStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'event-log-store-'));
    store = new SqliteEventLogStore({ dataDir: tmpDir });
  });

  afterEach(async () => {
    store.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  function evt(text: string): EventLogPayload {
    return { type: 'event', event: { type: 'text_delta', text } };
  }

  // ------------------------------------------------------------------
  // append + seq monotonicity
  // ------------------------------------------------------------------

  it('assigns seq 1 for the first append on a new conversation', () => {
    const seq = store.append('agent-a', 'conv-1', 'msg-1', evt('hi'));
    expect(seq).toBe(1);
  });

  it('assigns strictly increasing seqs within a single conversation', () => {
    const s1 = store.append('agent-a', 'conv-1', 'msg-1', evt('one'));
    const s2 = store.append('agent-a', 'conv-1', 'msg-1', evt('two'));
    const s3 = store.append('agent-a', 'conv-1', 'msg-2', evt('three'));
    expect(s1).toBe(1);
    expect(s2).toBe(2);
    expect(s3).toBe(3);
  });

  it('keeps per-conversation seq independent across conversations', () => {
    expect(store.append('agent-a', 'conv-1', 'msg-1', evt('a'))).toBe(1);
    expect(store.append('agent-a', 'conv-2', 'msg-2', evt('b'))).toBe(1);
    expect(store.append('agent-a', 'conv-1', 'msg-3', evt('c'))).toBe(2);
    expect(store.append('agent-a', 'conv-2', 'msg-4', evt('d'))).toBe(2);
  });

  it('keeps per-conversation seq independent across agents', () => {
    expect(store.append('agent-a', 'conv-1', 'm', evt('a'))).toBe(1);
    expect(store.append('agent-b', 'conv-1', 'm', evt('b'))).toBe(1);
    expect(store.append('agent-a', 'conv-1', 'm', evt('c'))).toBe(2);
  });

  // ------------------------------------------------------------------
  // readSince cursor semantics
  // ------------------------------------------------------------------

  it('readSince(0) returns every entry for a conversation in seq order', () => {
    store.append('agent-a', 'conv-1', 'msg-1', evt('one'));
    store.append('agent-a', 'conv-1', 'msg-1', evt('two'));
    store.append('agent-a', 'conv-1', 'msg-1', evt('three'));
    const entries = store.readSince('agent-a', 'conv-1', 0);
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it('readSince(N) returns only entries with seq > N', () => {
    store.append('agent-a', 'conv-1', 'msg-1', evt('one'));
    store.append('agent-a', 'conv-1', 'msg-1', evt('two'));
    store.append('agent-a', 'conv-1', 'msg-1', evt('three'));
    const entries = store.readSince('agent-a', 'conv-1', 1);
    expect(entries.map((e) => e.seq)).toEqual([2, 3]);
  });

  it('readSince beyond the tail returns an empty array', () => {
    store.append('agent-a', 'conv-1', 'msg-1', evt('one'));
    expect(store.readSince('agent-a', 'conv-1', 999)).toEqual([]);
  });

  it('readSince on an unknown conversation returns an empty array', () => {
    expect(store.readSince('agent-a', 'ghost', 0)).toEqual([]);
  });

  it('readSince round-trips the payload shape', () => {
    store.append('agent-a', 'conv-1', 'msg-1', {
      type: 'event',
      event: { type: 'text_delta', text: 'hello' },
    });
    store.append('agent-a', 'conv-1', 'msg-1', { type: 'done' });
    const entries = store.readSince('agent-a', 'conv-1', 0);
    expect(entries[0].payload).toEqual({
      type: 'event',
      event: { type: 'text_delta', text: 'hello' },
    });
    expect(entries[1].payload).toEqual({ type: 'done' });
  });

  // ------------------------------------------------------------------
  // Terminal markers
  // ------------------------------------------------------------------

  it('appends a done payload as a normal entry with an incremented seq', () => {
    store.append('agent-a', 'conv-1', 'msg-1', evt('hi'));
    const doneSeq = store.append('agent-a', 'conv-1', 'msg-1', { type: 'done' });
    expect(doneSeq).toBe(2);
    const entries = store.readSince('agent-a', 'conv-1', 0);
    expect(entries[1].payload).toEqual({ type: 'done' });
  });

  it('appends an error payload with the error text preserved', () => {
    store.append('agent-a', 'conv-1', 'msg-1', {
      type: 'error',
      error: 'stream died mid-response',
    });
    const entries = store.readSince('agent-a', 'conv-1', 0);
    expect(entries[0].payload).toEqual({
      type: 'error',
      error: 'stream died mid-response',
    });
  });

  // ------------------------------------------------------------------
  // deleteAgent / deleteConversation
  // ------------------------------------------------------------------

  it('deleteAgent removes every row for that agent and leaves others alone', () => {
    store.append('agent-a', 'conv-1', 'm', evt('a1'));
    store.append('agent-a', 'conv-2', 'm', evt('a2'));
    store.append('agent-b', 'conv-1', 'm', evt('b1'));

    store.deleteAgent('agent-a');

    expect(store.readSince('agent-a', 'conv-1', 0)).toEqual([]);
    expect(store.readSince('agent-a', 'conv-2', 0)).toEqual([]);
    expect(store.readSince('agent-b', 'conv-1', 0)).toHaveLength(1);
  });

  it('deleteAgent is idempotent on an unknown agent', () => {
    expect(() => store.deleteAgent('ghost')).not.toThrow();
  });

  it('deleteConversation removes only the targeted conversation', () => {
    store.append('agent-a', 'conv-1', 'm', evt('a1'));
    store.append('agent-a', 'conv-2', 'm', evt('a2'));

    store.deleteConversation('agent-a', 'conv-1');

    expect(store.readSince('agent-a', 'conv-1', 0)).toEqual([]);
    expect(store.readSince('agent-a', 'conv-2', 0)).toHaveLength(1);
  });

  it('a new append after deleteAgent restarts seq at 1', () => {
    store.append('agent-a', 'conv-1', 'm', evt('a'));
    store.append('agent-a', 'conv-1', 'm', evt('b'));
    store.deleteAgent('agent-a');
    const seq = store.append('agent-a', 'conv-1', 'm', evt('fresh'));
    expect(seq).toBe(1);
  });

  // ------------------------------------------------------------------
  // Persistence across reopen
  // ------------------------------------------------------------------

  it('survives close + reopen with seq continuing from the persisted tail', () => {
    store.append('agent-a', 'conv-1', 'm', evt('a'));
    store.append('agent-a', 'conv-1', 'm', evt('b'));
    store.close();

    const reopened = new SqliteEventLogStore({ dataDir: tmpDir });
    try {
      const nextSeq = reopened.append('agent-a', 'conv-1', 'm', evt('c'));
      expect(nextSeq).toBe(3);
      const entries = reopened.readSince('agent-a', 'conv-1', 0);
      expect(entries.map((e) => e.seq)).toEqual([1, 2, 3]);
    } finally {
      reopened.close();
    }
    // Rebind the outer `store` so afterEach's close() is a no-op on
    // a double-closed handle — close() on an already-closed DB is
    // safe in better-sqlite3, but let's be explicit.
    store = new SqliteEventLogStore({ dataDir: tmpDir });
  });
});
