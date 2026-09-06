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

interface PendingCreation {
  key: string;
  agentName: string;
  conversationId: string;
  epoch: number;
  retired: boolean;
  promise: Promise<PoolEntry>;
}

interface RetiredEntry {
  key: string;
  entry: PoolEntry;
}

interface RetiringGeneration {
  key: string;
  settled: Promise<void>;
  resolve(): void;
}

class PoolCreationRetiredError extends Error {
  constructor(agentName: string, conversationId: string) {
    super(`Pool creation for '${agentName}/${conversationId}' was retired`);
    this.name = 'PoolCreationRetiredError';
  }
}

export class ConversationPool {
  private pool = new Map<string, PoolEntry>();
  private pending = new Map<string, PendingCreation>();
  private retiring = new Map<string, RetiringGeneration>();
  private leaseRefs = new Map<string, LeaseRefState>();
  private legacyPins = new Set<string>();
  private slotEpochs = new Map<string, number>();
  private nextSlotEpoch = 0;
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

  getOrCreate(agentName: string, conversationId: string): Promise<PoolEntry> {
    const k = this.key(agentName, conversationId);
    const existing = this.pool.get(k);
    if (existing) {
      existing.lastActive = Date.now();
      return Promise.resolve(existing);
    }

    // An LRU victim is detached before stop() begins. A same-key caller must
    // wait until that slot transfer settles, then retry against the surviving
    // generation instead of receiving the doomed entry or racing its teardown.
    const retiring = this.retiring.get(k);
    if (retiring) {
      return retiring.settled.then(() => this.getOrCreate(agentName, conversationId));
    }

    // Deduplicate concurrent creates for the same key
    const inflight = this.pending.get(k);
    if (inflight) return inflight.promise;

    let victim: RetiredEntry | undefined;
    try {
      victim = this.reserveSlot();
    } catch (error) {
      return Promise.reject(error);
    }

    let resolveCreation!: (entry: PoolEntry) => void;
    let rejectCreation!: (error: unknown) => void;
    const promise = new Promise<PoolEntry>((resolve, reject) => {
      resolveCreation = resolve;
      rejectCreation = reject;
    });
    const creation: PendingCreation = {
      key: k,
      agentName,
      conversationId,
      epoch: ++this.nextSlotEpoch,
      retired: false,
      promise,
    };
    this.slotEpochs.set(k, creation.epoch);
    this.pending.set(k, creation);
    this.finishCreation(creation, victim).then(resolveCreation, rejectCreation);
    return promise;
  }

  private reserveSlot(): RetiredEntry | undefined {
    if (this.pool.size + this.pending.size < this.maxSize) return undefined;

    let oldest: { key: string; entry: PoolEntry } | undefined;
    for (const [key, entry] of this.pool) {
      if (entry.pinned) continue;
      if (!oldest || entry.lastActive < oldest.entry.lastActive) oldest = { key, entry };
    }
    if (!oldest) {
      throw new Error(
        `Pool is full (${this.maxSize} entries, all pinned, leased, or reserved). Cannot create new conversation.`,
      );
    }

    // Retire the victim atomically before stop() can yield. No same-key caller
    // can rediscover or pin an entry whose capacity slot is being transferred.
    this.retireEntry(oldest.key);
    return oldest;
  }

  private async finishCreation(
    creation: PendingCreation,
    victim?: RetiredEntry,
  ): Promise<PoolEntry> {
    let installed = false;
    let retiring: RetiringGeneration | undefined;
    try {
      if (victim) {
        retiring = this.beginRetirement(victim);
        await victim.entry.backend.stop();
      }
      this.assertCurrentCreation(creation);

      const { backend, agent } = await this.backendFactory(
        creation.agentName,
        creation.conversationId,
      );
      if (!this.isCurrentCreation(creation)) {
        await backend.stop();
        throw new PoolCreationRetiredError(creation.agentName, creation.conversationId);
      }

      const entry: PoolEntry = {
        backend,
        agent,
        lastActive: Date.now(),
        pinned:
          (this.leaseRefs.get(creation.key)?.count ?? 0) > 0 || this.legacyPins.has(creation.key),
      };
      this.pool.set(creation.key, entry);
      installed = true;
      return entry;
    } finally {
      if (this.pending.get(creation.key) === creation) {
        this.pending.delete(creation.key);
        if (!installed && this.slotEpochs.get(creation.key) === creation.epoch) {
          this.slotEpochs.delete(creation.key);
        }
      }
      if (retiring) {
        if (this.retiring.get(retiring.key) === retiring) this.retiring.delete(retiring.key);
        retiring.resolve();
      }
    }
  }

  private beginRetirement(victim: RetiredEntry): RetiringGeneration {
    let resolve!: () => void;
    const settled = new Promise<void>((done) => {
      resolve = done;
    });
    const retiring = { key: victim.key, settled, resolve };
    this.retiring.set(victim.key, retiring);
    return retiring;
  }

  private isCurrentCreation(creation: PendingCreation): boolean {
    return (
      !creation.retired &&
      this.pending.get(creation.key) === creation &&
      this.slotEpochs.get(creation.key) === creation.epoch
    );
  }

  private assertCurrentCreation(creation: PendingCreation): void {
    if (!this.isCurrentCreation(creation)) {
      throw new PoolCreationRetiredError(creation.agentName, creation.conversationId);
    }
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

  private retireEntry(key: string): PoolEntry | undefined {
    const entry = this.pool.get(key);
    if (!entry) return undefined;
    this.pool.delete(key);
    this.leaseRefs.delete(key);
    this.legacyPins.delete(key);
    this.slotEpochs.delete(key);
    return entry;
  }

  private retirePending(matches: (creation: PendingCreation) => boolean): PendingCreation[] {
    const retired: PendingCreation[] = [];
    for (const [key, creation] of this.pending) {
      if (!matches(creation)) continue;
      creation.retired = true;
      this.pending.delete(key);
      if (this.slotEpochs.get(key) === creation.epoch) this.slotEpochs.delete(key);
      this.leaseRefs.delete(key);
      this.legacyPins.delete(key);
      retired.push(creation);
    }
    return retired;
  }

  private async stopEntry(entry: PoolEntry, abortPinned: boolean): Promise<unknown[]> {
    const errors: unknown[] = [];
    if (abortPinned && entry.pinned) {
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
    return errors;
  }

  private async awaitRetiredCreations(creations: PendingCreation[]): Promise<unknown[]> {
    const results = await Promise.allSettled(creations.map((creation) => creation.promise));
    return results.flatMap((result) => {
      if (result.status === 'fulfilled' || result.reason instanceof PoolCreationRetiredError) {
        return [];
      }
      return [result.reason];
    });
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
    const toEvict: PoolEntry[] = [];
    for (const [key, entry] of this.pool) {
      if (!key.startsWith(prefix)) continue;
      this.retireEntry(key);
      toEvict.push(entry);
    }
    const pending = this.retirePending((creation) => creation.agentName === agentName);
    const [entryErrors, pendingErrors] = await Promise.all([
      Promise.all(toEvict.map((entry) => this.stopEntry(entry, true))),
      this.awaitRetiredCreations(pending),
    ]);
    const errors = [...entryErrors.flat(), ...pendingErrors];
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
    const toEvict: PoolEntry[] = [];
    for (const [key, entry] of this.pool) {
      if (entry.pinned) continue;
      this.retireEntry(key);
      toEvict.push(entry);
    }
    const errors = (await Promise.all(toEvict.map((entry) => this.stopEntry(entry, false)))).flat();
    if (errors.length > 0) throw errors[0];
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
    const entries: PoolEntry[] = [];
    for (const [key, entry] of this.pool) {
      this.retireEntry(key);
      entries.push(entry);
    }
    const pending = this.retirePending(() => true);
    const [entryErrors, pendingErrors] = await Promise.all([
      Promise.all(entries.map((entry) => this.stopEntry(entry, false))),
      this.awaitRetiredCreations(pending),
    ]);
    const errors = [...entryErrors.flat(), ...pendingErrors];
    if (errors.length > 0) throw errors[0];
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
