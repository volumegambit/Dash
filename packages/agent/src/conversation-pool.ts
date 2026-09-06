import type { DashAgent } from './agent.js';
import type { AgentBackend } from './types.js';

export interface PoolEntry {
  backend: AgentBackend;
  agent: DashAgent;
  lastActive: number;
  pinned: boolean;
}

export interface PoolLease {
  entry: PoolEntry;
  release(): void;
}

export type PoolBackendFactory = (
  agentName: string,
  conversationId: string,
) => Promise<{ backend: AgentBackend; agent: DashAgent }>;

export interface ConversationPoolOptions {
  maxSize: number;
  backendFactory: PoolBackendFactory;
}

interface LeaseRefState {
  count: number;
}

export class ConversationPool {
  private pool = new Map<string, PoolEntry>();
  private pending = new Map<string, Promise<PoolEntry>>();
  private leaseRefs = new Map<string, LeaseRefState>();
  private legacyPins = new Set<string>();
  private readonly maxSize: number;
  private readonly backendFactory: PoolBackendFactory;

  constructor(options: ConversationPoolOptions) {
    this.maxSize = options.maxSize;
    this.backendFactory = options.backendFactory;
  }

  get size(): number {
    return this.pool.size;
  }

  private key(agentName: string, conversationId: string): string {
    return `${agentName}/${conversationId}`;
  }

  async getOrCreate(agentName: string, conversationId: string): Promise<PoolEntry> {
    const k = this.key(agentName, conversationId);
    const existing = this.pool.get(k);
    if (existing) {
      existing.lastActive = Date.now();
      return existing;
    }

    // Deduplicate concurrent creates for the same key
    const inflight = this.pending.get(k);
    if (inflight) return inflight;

    let startCreation!: () => void;
    const startGate = new Promise<void>((resolve) => {
      startCreation = resolve;
    });
    const promise = (async () => {
      await startGate;
      try {
        return await this.createEntry(k, agentName, conversationId);
      } finally {
        this.pending.delete(k);
      }
    })();
    this.pending.set(k, promise);
    startCreation();
    return promise;
  }

  private async createEntry(
    k: string,
    agentName: string,
    conversationId: string,
  ): Promise<PoolEntry> {
    // `pending` already contains this creation. Counting it reserves capacity
    // before the factory awaits, closing the old getOrCreate()/pin() race.
    if (this.pool.size + this.pending.size > this.maxSize) {
      const evicted = await this.evictLRU();
      if (!evicted) {
        throw new Error(
          `Pool is full (${this.maxSize} entries, all pinned, leased, or reserved). Cannot create new conversation.`,
        );
      }
    }

    const { backend, agent } = await this.backendFactory(agentName, conversationId);
    const entry: PoolEntry = {
      backend,
      agent,
      lastActive: Date.now(),
      pinned: (this.leaseRefs.get(k)?.count ?? 0) > 0 || this.legacyPins.has(k),
    };
    this.pool.set(k, entry);
    return entry;
  }

  async acquire(agentName: string, conversationId: string): Promise<PoolLease> {
    const k = this.key(agentName, conversationId);
    const refs = this.leaseRefs.get(k) ?? { count: 0 };
    refs.count++;
    this.leaseRefs.set(k, refs);
    const existing = this.pool.get(k);
    if (existing) existing.pinned = true;

    let entry: PoolEntry;
    try {
      entry = await this.getOrCreate(agentName, conversationId);
      entry.pinned = true;
    } catch (error) {
      this.releaseLeaseRef(k, refs);
      throw error;
    }

    let released = false;
    return {
      entry,
      release: () => {
        if (released) return;
        released = true;
        this.releaseLeaseRef(k, refs);
      },
    };
  }

  private releaseLeaseRef(k: string, refs: LeaseRefState): void {
    // Forced eviction retires the whole generation. A late release from that
    // generation must not decrement a replacement entry's independent count.
    if (this.leaseRefs.get(k) !== refs) return;
    const next = refs.count - 1;
    refs.count = next;
    if (next > 0) this.leaseRefs.set(k, refs);
    else this.leaseRefs.delete(k);
    const entry = this.pool.get(k);
    if (entry) entry.pinned = next > 0 || this.legacyPins.has(k);
  }

  private async evictLRU(): Promise<boolean> {
    let oldest: { key: string; time: number } | null = null;
    for (const [key, entry] of this.pool) {
      if (entry.pinned) continue;
      if (!oldest || entry.lastActive < oldest.time) {
        oldest = { key, time: entry.lastActive };
      }
    }
    if (oldest) {
      const entry = this.pool.get(oldest.key);
      if (entry) {
        await entry.backend.stop();
        this.pool.delete(oldest.key);
        return true;
      }
    }
    return false;
  }

  pin(agentName: string, conversationId: string): void {
    const k = this.key(agentName, conversationId);
    this.legacyPins.add(k);
    const entry = this.pool.get(k);
    if (entry) entry.pinned = true;
  }

  unpin(agentName: string, conversationId: string): void {
    const k = this.key(agentName, conversationId);
    this.legacyPins.delete(k);
    const entry = this.pool.get(k);
    if (entry) entry.pinned = (this.leaseRefs.get(k)?.count ?? 0) > 0;
  }

  get(agentName: string, conversationId: string): PoolEntry | undefined {
    return this.pool.get(this.key(agentName, conversationId));
  }

  has(agentName: string, conversationId: string): boolean {
    return this.pool.has(this.key(agentName, conversationId));
  }

  async evictAgent(agentName: string): Promise<void> {
    const prefix = `${agentName}/`;
    const toEvict: Array<[string, PoolEntry]> = [];
    for (const [key, entry] of this.pool) {
      if (key.startsWith(prefix)) toEvict.push([key, entry]);
    }
    const errors: unknown[] = [];
    await Promise.all(
      toEvict.map(async ([, entry]) => {
        if (entry.pinned) {
          try {
            entry.backend.abort();
          } catch (error) {
            errors.push(error);
          }
        }
        try {
          await entry.backend.stop();
        } catch (error) {
          errors.push(error);
        }
      }),
    );
    for (const [key] of toEvict) {
      this.pool.delete(key);
      this.leaseRefs.delete(key);
      this.legacyPins.delete(key);
    }
    if (errors.length > 0) throw errors[0];
  }

  /**
   * Evict every IDLE (unpinned) backend, leaving pinned in-flight conversations
   * alone to drain. Used by plugin hot-reload: plugin wiring is global to all
   * agents, so on reload we reset every warm backend so it rebuilds with the new
   * wiring on next use — but pinned conversations are mid-stream and must NOT be
   * interrupted (they keep their old wiring until they finish, then unpin and
   * fall out of the pool naturally).
   *
   * Distinct from `clear()` (stops ALL incl. pinned, no abort) and `evictAgent()`
   * (aborts pinned) — neither fits the "reset idle, drain pinned" semantics.
   */
  async evictIdle(): Promise<void> {
    const toEvict: string[] = [];
    for (const [key, entry] of this.pool) {
      if (entry.pinned) continue;
      await entry.backend.stop();
      toEvict.push(key);
    }
    for (const key of toEvict) {
      this.pool.delete(key);
      this.leaseRefs.delete(key);
      this.legacyPins.delete(key);
    }
  }

  async forAgent(agentName: string, fn: (entry: PoolEntry) => Promise<void>): Promise<void> {
    const prefix = `${agentName}/`;
    for (const [key, entry] of this.pool) {
      if (key.startsWith(prefix)) {
        await fn(entry);
      }
    }
  }

  async clear(): Promise<void> {
    const entries = [...this.pool.values()];
    const results = await Promise.allSettled(entries.map((entry) => entry.backend.stop()));
    this.pool.clear();
    this.leaseRefs.clear();
    this.legacyPins.clear();
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }

  stats(): { size: number; maxSize: number; pinned: number; agents: Record<string, number> } {
    const agents: Record<string, number> = {};
    let pinned = 0;
    for (const [key, entry] of this.pool) {
      const agentName = key.split('/')[0];
      agents[agentName] = (agents[agentName] ?? 0) + 1;
      if (entry.pinned) pinned++;
    }
    return { size: this.pool.size, maxSize: this.maxSize, pinned, agents };
  }
}
