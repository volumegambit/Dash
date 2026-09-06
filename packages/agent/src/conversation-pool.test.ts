import { describe, expect, it, vi } from 'vitest';
import type { ConversationPoolOptions, PoolEntry, PoolLease } from './conversation-pool.js';
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

  it('evictAgent continues teardown and removes every target when one stop rejects', async () => {
    const backends = [mockBackend('first'), mockBackend('second')];
    backends[0].stop = vi.fn().mockRejectedValue(new Error('first stop failed'));
    let call = 0;
    const pool = new ConversationPool({
      maxSize: 10,
      backendFactory: vi.fn(async () => ({ backend: backends[call++], agent: mockAgent() })),
    });
    await pool.getOrCreate('agent-a', 'conv-1');
    await pool.getOrCreate('agent-a', 'conv-2');

    await expect(pool.evictAgent('agent-a')).rejects.toThrow('first stop failed');
    expect(backends[0].stop).toHaveBeenCalledTimes(1);
    expect(backends[1].stop).toHaveBeenCalledTimes(1);
    expect(pool.has('agent-a', 'conv-1')).toBe(false);
    expect(pool.has('agent-a', 'conv-2')).toBe(false);
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

  it('evictIdle stops and removes unpinned entries but keeps pinned ones', async () => {
    const stopped: string[] = [];
    let callCount = 0;
    const factory = vi.fn().mockImplementation(async () => {
      const name = `b-${callCount++}`;
      const backend = mockBackend(name);
      backend.stop = vi.fn().mockImplementation(async () => {
        stopped.push(name);
      });
      return { backend, agent: mockAgent() };
    });

    const pool = new ConversationPool({ maxSize: 10, backendFactory: factory });
    await pool.getOrCreate('a', 'conv-1'); // b-0 — idle
    await pool.getOrCreate('a', 'conv-2'); // b-1 — will be pinned
    await pool.getOrCreate('b', 'conv-1'); // b-2 — idle
    pool.pin('a', 'conv-2');

    await pool.evictIdle();

    // Idle entries are stopped + removed; the pinned one survives untouched.
    expect(pool.has('a', 'conv-1')).toBe(false);
    expect(pool.has('b', 'conv-1')).toBe(false);
    expect(pool.has('a', 'conv-2')).toBe(true);
    expect(pool.size).toBe(1);
    expect(stopped).toContain('b-0');
    expect(stopped).toContain('b-2');
    expect(stopped).not.toContain('b-1');
  });

  it('evictIdle does not abort the pinned in-flight backend', async () => {
    const backend = mockBackend();
    const pool = new ConversationPool({
      maxSize: 10,
      backendFactory: vi.fn().mockResolvedValue({ backend, agent: mockAgent() }),
    });

    await pool.getOrCreate('a', 'conv-1');
    pool.pin('a', 'conv-1');

    await pool.evictIdle();

    // Pinned in-flight conversations drain — never aborted, never stopped.
    expect(backend.abort).not.toHaveBeenCalled();
    expect(backend.stop).not.toHaveBeenCalled();
    expect(pool.has('a', 'conv-1')).toBe(true);
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

  it('clear continues stopping and empties the pool when one backend rejects', async () => {
    const backends = [mockBackend('first'), mockBackend('second')];
    backends[0].stop = vi.fn().mockRejectedValue(new Error('clear stop failed'));
    let call = 0;
    const pool = new ConversationPool({
      maxSize: 10,
      backendFactory: vi.fn(async () => ({ backend: backends[call++], agent: mockAgent() })),
    });
    await pool.getOrCreate('a', 'conv-1');
    await pool.getOrCreate('b', 'conv-2');

    await expect(pool.clear()).rejects.toThrow('clear stop failed');
    expect(backends[0].stop).toHaveBeenCalledTimes(1);
    expect(backends[1].stop).toHaveBeenCalledTimes(1);
    expect(pool.size).toBe(0);
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

  it('acquires same-key leases atomically and releases each reference exactly once', async () => {
    const pool = makePool();
    const first: PoolLease = await pool.acquire('a', 'conv-1');
    const second = await pool.acquire('a', 'conv-1');

    expect(first.entry).toBe(second.entry);
    expect(pool.stats().pinned).toBe(1);
    first.release();
    first.release();
    expect(pool.stats().pinned).toBe(1);
    second.release();
    expect(pool.stats().pinned).toBe(0);
  });

  it('reserves maxSize capacity while a different-key creation is pending', async () => {
    const firstFactory = deferredFactory();
    const factory = vi
      .fn()
      .mockImplementationOnce(() => firstFactory.promise)
      .mockResolvedValue({ backend: mockBackend('unexpected'), agent: mockAgent() });
    const pool = new ConversationPool({ maxSize: 1, backendFactory: factory });

    const firstLeasePromise = pool.acquire('a', 'conv-1');
    await Promise.resolve();
    await expect(pool.acquire('b', 'conv-2')).rejects.toThrow(/all leased|full/);
    expect(factory).toHaveBeenCalledTimes(1);

    firstFactory.resolve({ backend: mockBackend('created'), agent: mockAgent() });
    const first = await firstLeasePromise;
    first.release();
  });

  it('deduplicates concurrent same-key creation while granting two references', async () => {
    const pending = deferredFactory();
    const factory = vi.fn(() => pending.promise);
    const pool = new ConversationPool({ maxSize: 1, backendFactory: factory });

    const firstPromise = pool.acquire('a', 'conv-1');
    const secondPromise = pool.acquire('a', 'conv-1');
    pending.resolve({ backend: mockBackend(), agent: mockAgent() });
    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect(factory).toHaveBeenCalledTimes(1);
    first.release();
    expect(pool.stats().pinned).toBe(1);
    second.release();
    expect(pool.stats().pinned).toBe(0);
  });

  it('releases a failed creation reservation so another key can be acquired', async () => {
    const factory = vi
      .fn()
      .mockRejectedValueOnce(new Error('factory failed'))
      .mockResolvedValueOnce({ backend: mockBackend(), agent: mockAgent() });
    const pool = new ConversationPool({ maxSize: 1, backendFactory: factory });

    await expect(pool.acquire('a', 'conv-1')).rejects.toThrow('factory failed');
    const lease = await pool.acquire('b', 'conv-2');
    expect(lease.entry.backend.name).toBe('mock');
    lease.release();
  });

  it('evicts only after the final lease reference is released', async () => {
    const firstBackend = mockBackend('first');
    const secondBackend = mockBackend('second');
    const factory = vi
      .fn()
      .mockResolvedValueOnce({ backend: firstBackend, agent: mockAgent() })
      .mockResolvedValueOnce({ backend: secondBackend, agent: mockAgent() });
    const pool = new ConversationPool({ maxSize: 1, backendFactory: factory });

    const first = await pool.acquire('a', 'conv-1');
    await expect(pool.acquire('b', 'conv-2')).rejects.toThrow(/all leased|full/);
    expect(firstBackend.stop).not.toHaveBeenCalled();

    first.release();
    const second = await pool.acquire('b', 'conv-2');
    expect(firstBackend.stop).toHaveBeenCalledTimes(1);
    expect(second.entry.backend).toBe(secondBackend);
    second.release();
  });

  it('does not let a stale forced-eviction lease release unpin a replacement generation', async () => {
    const pool = makePool();
    const stale = await pool.acquire('a', 'conv-1');
    await pool.evictAgent('a');
    const replacement = await pool.acquire('a', 'conv-1');

    stale.release();
    expect(pool.stats().pinned).toBe(1);
    replacement.release();
    expect(pool.stats().pinned).toBe(0);
  });

  it('atomically retires a same-key LRU entry before awaiting its blocked stop', async () => {
    const stopGate = deferred<void>();
    const retiredBackend = mockBackend('retired');
    retiredBackend.stop = vi.fn(() => stopGate.promise);
    const factory = vi
      .fn()
      .mockResolvedValueOnce({ backend: retiredBackend, agent: mockAgent() })
      .mockResolvedValueOnce({ backend: mockBackend('new-key'), agent: mockAgent() })
      .mockResolvedValueOnce({ backend: mockBackend('same-key replacement'), agent: mockAgent() });
    const pool = new ConversationPool({ maxSize: 1, backendFactory: factory });
    const retired = await pool.getOrCreate('a', 'old');

    const replacementPromise = pool.getOrCreate('b', 'new');
    expect(retiredBackend.stop).toHaveBeenCalledTimes(1);
    expect(pool.get('a', 'old')).toBeUndefined();
    let retrySettled = false;
    const retryPromise = pool.acquire('a', 'old').then((lease) => {
      retrySettled = true;
      return lease;
    });
    await Promise.resolve();
    expect(retrySettled).toBe(false);
    expect(pool.get('a', 'old')).not.toBe(retired);

    stopGate.resolve();
    await replacementPromise;
    const retried = await retryPromise;
    expect(retried.entry).not.toBe(retired);
    expect(retried.entry.backend.name).toBe('same-key replacement');
    retried.release();
  });

  it('reserves capacity atomically for two creators while stopping one LRU only once', async () => {
    const stopGate = deferred<void>();
    const retiredBackend = mockBackend('retired');
    retiredBackend.stop = vi.fn(() => stopGate.promise);
    const factory = vi.fn(async (agentName: string) => ({
      backend: agentName === 'old' ? retiredBackend : mockBackend(agentName),
      agent: mockAgent(),
    }));
    const pool = new ConversationPool({ maxSize: 2, backendFactory: factory });
    await pool.getOrCreate('old', 'conversation');

    const firstPromise = pool.acquire('first', 'conversation');
    const secondPromise = pool.acquire('second', 'conversation');
    expect(retiredBackend.stop).toHaveBeenCalledTimes(1);
    stopGate.resolve();
    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect(pool.size).toBe(2);
    expect(first.entry.backend.name).toBe('first');
    expect(second.entry.backend.name).toBe('second');
    first.release();
    second.release();
  });

  it('retires a failed-stop victim and releases the creator reservation for retry', async () => {
    const stopGate = deferred<void>();
    const retiredBackend = mockBackend('retired');
    retiredBackend.stop = vi.fn(() => stopGate.promise);
    const factory = vi
      .fn()
      .mockResolvedValueOnce({ backend: retiredBackend, agent: mockAgent() })
      .mockResolvedValueOnce({ backend: mockBackend('fresh'), agent: mockAgent() });
    const pool = new ConversationPool({ maxSize: 1, backendFactory: factory });
    await pool.getOrCreate('a', 'old');

    const failedCreator = pool.acquire('b', 'new');
    const sameKeyRetry = pool.acquire('a', 'old');
    stopGate.reject(new Error('stop failed'));

    await expect(failedCreator).rejects.toThrow('stop failed');
    expect(pool.has('b', 'new')).toBe(false);

    const retry = await sameKeyRetry;
    expect(retry.entry.backend).not.toBe(retiredBackend);
    expect(retry.entry.backend.name).toBe('fresh');
    expect(factory).toHaveBeenCalledTimes(2);
    retry.release();
  });

  it('clear retires and awaits a pending factory, then disposes its late backend', async () => {
    const pending = deferredFactory();
    const pool = new ConversationPool({ maxSize: 1, backendFactory: vi.fn(() => pending.promise) });
    const acquireOutcome = pool.acquire('a', 'conversation').then(
      () => null,
      (error: unknown) => error,
    );
    await Promise.resolve();

    let clearSettled = false;
    const clearPromise = pool.clear().then(() => {
      clearSettled = true;
    });
    await Promise.resolve();
    expect(clearSettled).toBe(false);

    const lateBackend = mockBackend('late');
    pending.resolve({ backend: lateBackend, agent: mockAgent() });
    await clearPromise;
    expect(await acquireOutcome).toMatchObject({ message: expect.stringMatching(/retired/) });
    expect(lateBackend.stop).toHaveBeenCalledTimes(1);
    expect(pool.size).toBe(0);
  });

  it('evictAgent retires an old pending epoch without deleting its same-key replacement', async () => {
    const pending = deferredFactory();
    const freshBackend = mockBackend('fresh');
    const factory = vi
      .fn()
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValueOnce({ backend: freshBackend, agent: mockAgent() });
    const pool = new ConversationPool({ maxSize: 1, backendFactory: factory });
    const staleOutcome = pool.acquire('a', 'conversation').then(
      () => null,
      (error: unknown) => error,
    );
    await Promise.resolve();

    const eviction = pool.evictAgent('a');
    const freshPromise = pool.acquire('a', 'conversation');
    const staleBackend = mockBackend('stale');
    pending.resolve({ backend: staleBackend, agent: mockAgent() });

    await eviction;
    const fresh = await freshPromise;
    expect(await staleOutcome).toMatchObject({ message: expect.stringMatching(/retired/) });
    expect(staleBackend.stop).toHaveBeenCalledTimes(1);
    expect(pool.get('a', 'conversation')?.backend).toBe(freshBackend);
    expect(pool.stats().pinned).toBe(1);
    fresh.release();
  });
});

function deferredFactory() {
  let resolve!: (value: { backend: AgentBackend; agent: ReturnType<typeof mockAgent> }) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<{ backend: AgentBackend; agent: ReturnType<typeof mockAgent> }>(
    (res, rej) => {
      resolve = res;
      reject = rej;
    },
  );
  return { promise, resolve, reject };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
