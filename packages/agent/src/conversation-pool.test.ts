import { describe, expect, it, vi } from 'vitest';
import type { ConversationPoolOptions, PoolEntry } from './conversation-pool.js';
import { ConversationPool } from './conversation-pool.js';
import type { AgentBackend, AgentEvent, AgentState, RunOptions } from './types.js';

function mockBackend(name = 'mock'): AgentBackend {
  return {
    name,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    run: vi.fn() as unknown as (
      state: AgentState,
      options: RunOptions,
    ) => AsyncGenerator<AgentEvent>,
    abort: vi.fn(),
    updateCredentials: vi.fn().mockResolvedValue(undefined),
  };
}

// biome-ignore lint/suspicious/noExplicitAny: lightweight mock for tests
function mockAgent(): any {
  return { chat: vi.fn() };
}

function makePool(overrides: Partial<ConversationPoolOptions> = {}): ConversationPool {
  return new ConversationPool({
    maxSize: 10,
    backendFactory: vi.fn().mockResolvedValue({
      backend: mockBackend(),
      agent: mockAgent(),
    }),
    ...overrides,
  });
}

describe('ConversationPool', () => {
  it('creates and retrieves a conversation backend', async () => {
    const backend = mockBackend();
    const agent = mockAgent();
    const pool = new ConversationPool({
      maxSize: 10,
      backendFactory: vi.fn().mockResolvedValue({ backend, agent }),
    });

    const entry = await pool.getOrCreate('agent-a', 'conv-1');
    expect(entry.backend).toBe(backend);

    const entry2 = await pool.getOrCreate('agent-a', 'conv-1');
    expect(entry2.backend).toBe(backend);
    expect(pool.size).toBe(1);
  });

  it('creates separate entries for different keys', async () => {
    const pool = makePool();
    await pool.getOrCreate('agent-a', 'conv-1');
    await pool.getOrCreate('agent-a', 'conv-2');
    await pool.getOrCreate('agent-b', 'conv-1');
    expect(pool.size).toBe(3);
  });

  it('evicts LRU entry when maxSize is reached', async () => {
    const stoppedBackends: string[] = [];
    let callCount = 0;

    const factory = vi.fn().mockImplementation(async () => {
      const name = `backend-${callCount++}`;
      const backend = mockBackend(name);
      backend.stop = vi.fn().mockImplementation(async () => {
        stoppedBackends.push(name);
      });
      return { backend, agent: mockAgent() };
    });

    const pool = new ConversationPool({ maxSize: 2, backendFactory: factory });

    await pool.getOrCreate('a', 'conv-1');
    await pool.getOrCreate('a', 'conv-2');
    expect(pool.size).toBe(2);

    // This should evict conv-1 (oldest)
    await pool.getOrCreate('a', 'conv-3');
    expect(pool.size).toBe(2);
    expect(stoppedBackends).toContain('backend-0');
    expect(pool.has('a', 'conv-1')).toBe(false);
    expect(pool.has('a', 'conv-2')).toBe(true);
    expect(pool.has('a', 'conv-3')).toBe(true);
  });

  it('does not evict pinned entries', async () => {
    let callCount = 0;
    const factory = vi.fn().mockImplementation(async () => {
      return { backend: mockBackend(`b-${callCount++}`), agent: mockAgent() };
    });

    const pool = new ConversationPool({ maxSize: 2, backendFactory: factory });

    await pool.getOrCreate('a', 'conv-1');
    await pool.getOrCreate('a', 'conv-2');
    pool.pin('a', 'conv-1');

    // conv-1 is pinned, so conv-2 should be evicted instead
    await pool.getOrCreate('a', 'conv-3');
    expect(pool.has('a', 'conv-1')).toBe(true);
    expect(pool.has('a', 'conv-2')).toBe(false);
    expect(pool.has('a', 'conv-3')).toBe(true);
  });

  it('unpin allows eviction again', async () => {
    let callCount = 0;
    const factory = vi.fn().mockImplementation(async () => {
      return { backend: mockBackend(`b-${callCount++}`), agent: mockAgent() };
    });

    const pool = new ConversationPool({ maxSize: 2, backendFactory: factory });

    await pool.getOrCreate('a', 'conv-1');
    await pool.getOrCreate('a', 'conv-2');
    pool.pin('a', 'conv-1');
    pool.unpin('a', 'conv-1');

    // conv-1 is no longer pinned, LRU should evict it
    await pool.getOrCreate('a', 'conv-3');
    expect(pool.has('a', 'conv-1')).toBe(false);
  });

  it('deduplicates concurrent getOrCreate calls for the same key', async () => {
    let factoryCalls = 0;
    const factory = vi.fn().mockImplementation(async () => {
      factoryCalls++;
      return { backend: mockBackend(), agent: mockAgent() };
    });

    const pool = new ConversationPool({ maxSize: 10, backendFactory: factory });

    const [entry1, entry2] = await Promise.all([
      pool.getOrCreate('a', 'conv-1'),
      pool.getOrCreate('a', 'conv-1'),
    ]);

    expect(factoryCalls).toBe(1);
    expect(entry1).toBe(entry2);
  });

  it('get returns undefined for unknown keys', () => {
    const pool = makePool();
    expect(pool.get('x', 'y')).toBeUndefined();
  });

  it('has returns false for unknown keys', () => {
    const pool = makePool();
    expect(pool.has('x', 'y')).toBe(false);
  });

  it('evictAgent removes all entries for an agent', async () => {
    const pool = makePool();
    await pool.getOrCreate('agent-a', 'conv-1');
    await pool.getOrCreate('agent-a', 'conv-2');
    await pool.getOrCreate('agent-b', 'conv-1');
    expect(pool.size).toBe(3);

    await pool.evictAgent('agent-a');
    expect(pool.size).toBe(1);
    expect(pool.has('agent-a', 'conv-1')).toBe(false);
    expect(pool.has('agent-a', 'conv-2')).toBe(false);
    expect(pool.has('agent-b', 'conv-1')).toBe(true);
  });

  it('evictAgent aborts pinned entries before stopping', async () => {
    const backend = mockBackend();
    const pool = new ConversationPool({
      maxSize: 10,
      backendFactory: vi.fn().mockResolvedValue({ backend, agent: mockAgent() }),
    });

    await pool.getOrCreate('a', 'conv-1');
    pool.pin('a', 'conv-1');

    await pool.evictAgent('a');
    expect(backend.abort).toHaveBeenCalled();
    expect(backend.stop).toHaveBeenCalled();
    expect(pool.size).toBe(0);
  });

  it('forAgent iterates entries for a given agent', async () => {
    const pool = makePool();
    await pool.getOrCreate('agent-a', 'conv-1');
    await pool.getOrCreate('agent-a', 'conv-2');
    await pool.getOrCreate('agent-b', 'conv-1');

    const visited: PoolEntry[] = [];
    await pool.forAgent('agent-a', async (entry) => {
      visited.push(entry);
    });

    expect(visited).toHaveLength(2);
  });

  it('clear stops all backends and empties the pool', async () => {
    const backends: AgentBackend[] = [];
    const factory = vi.fn().mockImplementation(async () => {
      const b = mockBackend();
      backends.push(b);
      return { backend: b, agent: mockAgent() };
    });

    const pool = new ConversationPool({ maxSize: 10, backendFactory: factory });
    await pool.getOrCreate('a', 'conv-1');
    await pool.getOrCreate('b', 'conv-2');

    await pool.clear();
    expect(pool.size).toBe(0);
    for (const b of backends) {
      expect(b.stop).toHaveBeenCalled();
    }
  });

  it('stats returns correct pool statistics', async () => {
    const pool = makePool();
    await pool.getOrCreate('agent-a', 'conv-1');
    await pool.getOrCreate('agent-a', 'conv-2');
    await pool.getOrCreate('agent-b', 'conv-1');
    pool.pin('agent-a', 'conv-1');

    const s = pool.stats();
    expect(s.size).toBe(3);
    expect(s.maxSize).toBe(10);
    expect(s.pinned).toBe(1);
    expect(s.agents).toEqual({ 'agent-a': 2, 'agent-b': 1 });
  });

  it('getOrCreate updates lastActive on cache hit', async () => {
    const pool = makePool();
    const entry1 = await pool.getOrCreate('a', 'conv-1');
    const firstActive = entry1.lastActive;

    // Small delay to ensure Date.now() differs
    await new Promise((r) => setTimeout(r, 5));

    const entry2 = await pool.getOrCreate('a', 'conv-1');
    expect(entry2.lastActive).toBeGreaterThan(firstActive);
  });

  it('throws when pool is full and all entries are pinned', async () => {
    const pool = new ConversationPool({
      maxSize: 2,
      backendFactory: vi.fn().mockImplementation(async () => ({
        backend: mockBackend(),
        agent: mockAgent(),
      })),
    });

    await pool.getOrCreate('a', 'conv-1');
    pool.pin('a', 'conv-1');
    await pool.getOrCreate('b', 'conv-2');
    pool.pin('b', 'conv-2');

    await expect(pool.getOrCreate('c', 'conv-3')).rejects.toThrow(/all pinned/);
  });
});
