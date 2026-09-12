import type { DashAgent } from './agent.js';
import type { AgentBackend } from './types.js';

export interface PoolEntry {
  backend: AgentBackend;
  agent: DashAgent;
  lastActive: number;
  /**
   * How many turns are in flight on this entry. A COUNT, not a flag: two turns
   * can overlap on one conversation (the legacy chat path, the management API
   * and the channel bridge all reach `chat()` without the hub's turn lease),
   * and with a boolean the first to finish would unpin an entry the second is
   * still streaming — leaving `dropConversation` free to stop a live backend.
   */
  pins: number;
  /**
   * What this entry was BUILT from, when the caller's backend depends on
   * something that can change between turns. A backend binds its tool set (and
   * its MCP allow-list) at `start()`, so an entry whose signature no longer
   * matches cannot be reused — see {@link dropConversation}. Unused for
   * ordinary agent conversations, whose config is re-read per turn.
   */
  signature?: string;
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
  admission?: {
    capture(agentId: string, conversationId: string): unknown;
    isCurrent(token: unknown): boolean;
  };
}

interface LeaseRefState {
  count: number;
}

interface PendingCreation {
  key: string;
  agentName: string;
  conversationId: string;
  epoch: number;
  processEpoch: number;
  agentEpoch: number;
  externalToken?: unknown;
  retired: boolean;
  promise: Promise<PoolEntry>;
}

interface RetiredEntry {
  key: string;
  agentName: string;
  entry: PoolEntry;
}

interface RetiringGeneration {
  key: string;
  agentName: string;
  error?: unknown;
  settled: Promise<void>;
  resolve(): void;
}

interface AdmissionEpoch {
  process: number;
  agent: number;
  externalToken?: unknown;
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
  private legacyPins = new Map<string, number>();
  private entryAgents = new Map<string, string>();
  private slotEpochs = new Map<string, number>();
  private agentEpochs = new Map<string, number>();
  private processEpoch = 0;
  private processRetiring = false;
  private readonly retiringAgents = new Set<string>();
  private processRetirement?: Promise<void>;
  private readonly agentRetirements = new Map<string, Promise<void>>();
  private nextSlotEpoch = 0;
  private readonly maxSize: number;
  private readonly backendFactory: PoolBackendFactory;
  private readonly admission?: ConversationPoolOptions['admission'];

  constructor(options: ConversationPoolOptions) {
    this.maxSize = options.maxSize;
    this.backendFactory = options.backendFactory;
    this.admission = options.admission;
  }

  get size(): number {
    return this.pool.size;
  }

  private key(agentName: string, conversationId: string): string {
    return `${agentName}/${conversationId}`;
  }

  getOrCreate(agentName: string, conversationId: string): Promise<PoolEntry> {
    return this.getOrCreateAtEpoch(
      agentName,
      conversationId,
      this.captureAdmissionEpoch(agentName, conversationId),
    );
  }

  private getOrCreateAtEpoch(
    agentName: string,
    conversationId: string,
    admission: AdmissionEpoch,
  ): Promise<PoolEntry> {
    try {
      this.assertAdmissionCurrent(agentName, conversationId, admission);
    } catch (error) {
      return Promise.reject(error);
    }
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
      return retiring.settled.then(() =>
        this.getOrCreateAtEpoch(agentName, conversationId, admission),
      );
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
      processEpoch: admission.process,
      agentEpoch: admission.agent,
      externalToken: admission.externalToken,
      retired: false,
      promise,
    };
    this.slotEpochs.set(k, creation.epoch);
    this.pending.set(k, creation);
    this.finishCreation(creation, victim).then(resolveCreation, rejectCreation);
    return promise;
  }

  private captureAdmissionEpoch(agentName: string, conversationId: string): AdmissionEpoch {
    if (this.processRetiring || this.retiringAgents.has(agentName)) {
      throw new PoolCreationRetiredError(agentName, conversationId);
    }
    return {
      process: this.processEpoch,
      agent: this.agentEpochs.get(agentName) ?? 0,
      externalToken: this.admission?.capture(agentName, conversationId),
    };
  }

  private isAdmissionCurrent(agentName: string, admission: AdmissionEpoch): boolean {
    return (
      admission.process === this.processEpoch &&
      admission.agent === (this.agentEpochs.get(agentName) ?? 0) &&
      !this.processRetiring &&
      !this.retiringAgents.has(agentName) &&
      (admission.externalToken === undefined ||
        this.admission?.isCurrent(admission.externalToken) === true)
    );
  }

  private assertAdmissionCurrent(
    agentName: string,
    conversationId: string,
    admission: AdmissionEpoch,
  ): void {
    if (!this.isAdmissionCurrent(agentName, admission)) {
      throw new PoolCreationRetiredError(agentName, conversationId);
    }
  }

  private reserveSlot(): RetiredEntry | undefined {
    if (this.pool.size + this.pending.size < this.maxSize) return undefined;

    let oldest: RetiredEntry | undefined;
    for (const [key, entry] of this.pool) {
      if (entry.pins > 0) continue;
      if (!oldest || entry.lastActive < oldest.entry.lastActive) {
        oldest = { key, agentName: this.entryAgents.get(key) ?? key.split('/')[0], entry };
      }
    }
    if (!oldest) {
      throw new Error(
        `Pool is full (${this.maxSize} entries, all pinned, leased, or reserved). Cannot create new conversation.`,
      );
    }

    // Retire the victim atomically before stop() can yield. No same-key caller
    // can rediscover or pin an entry whose capacity slot is being transferred.
    return this.retireEntry(oldest.key);
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
        try {
          await victim.entry.backend.stop();
        } catch (error) {
          retiring.error = error;
          throw error;
        }
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
        pins:
          (this.leaseRefs.get(creation.key)?.count ?? 0) + (this.legacyPins.get(creation.key) ?? 0),
      };
      this.pool.set(creation.key, entry);
      this.entryAgents.set(creation.key, creation.agentName);
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
    const retiring = { key: victim.key, agentName: victim.agentName, settled, resolve };
    this.retiring.set(victim.key, retiring);
    return retiring;
  }

  private isCurrentCreation(creation: PendingCreation): boolean {
    return (
      !creation.retired &&
      this.pending.get(creation.key) === creation &&
      this.slotEpochs.get(creation.key) === creation.epoch &&
      creation.processEpoch === this.processEpoch &&
      creation.agentEpoch === (this.agentEpochs.get(creation.agentName) ?? 0) &&
      !this.processRetiring &&
      !this.retiringAgents.has(creation.agentName) &&
      (creation.externalToken === undefined ||
        this.admission?.isCurrent(creation.externalToken) === true)
    );
  }

  private assertCurrentCreation(creation: PendingCreation): void {
    if (!this.isCurrentCreation(creation)) {
      throw new PoolCreationRetiredError(creation.agentName, creation.conversationId);
    }
  }

  async acquire(agentName: string, conversationId: string): Promise<PoolLease> {
    const admission = this.captureAdmissionEpoch(agentName, conversationId);
    const k = this.key(agentName, conversationId);
    const refs = this.leaseRefs.get(k) ?? { count: 0 };
    refs.count++;
    this.leaseRefs.set(k, refs);
    const existing = this.pool.get(k);
    if (existing) existing.pins++;

    let entry: PoolEntry;
    try {
      entry = await this.getOrCreateAtEpoch(agentName, conversationId, admission);
      this.assertAdmissionCurrent(agentName, conversationId, admission);
      if (this.pool.get(k) !== entry) {
        throw new PoolCreationRetiredError(agentName, conversationId);
      }
      entry.pins = refs.count + (this.legacyPins.get(k) ?? 0);
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
    if (entry) entry.pins = Math.max(0, next) + (this.legacyPins.get(k) ?? 0);
  }

  private retireEntry(key: string): RetiredEntry | undefined {
    const entry = this.pool.get(key);
    if (!entry) return undefined;
    const agentName = this.entryAgents.get(key) ?? key.split('/')[0];
    this.pool.delete(key);
    this.entryAgents.delete(key);
    this.leaseRefs.delete(key);
    this.legacyPins.delete(key);
    this.slotEpochs.delete(key);
    return { key, agentName, entry };
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
    if (abortPinned && entry.pins > 0) {
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

  private async awaitRetirements(retirements: RetiringGeneration[]): Promise<unknown[]> {
    await Promise.all(retirements.map((retirement) => retirement.settled));
    return retirements.flatMap((retirement) =>
      retirement.error === undefined ? [] : [retirement.error],
    );
  }

  pin(agentName: string, conversationId: string): void {
    const k = this.key(agentName, conversationId);
    this.legacyPins.set(k, (this.legacyPins.get(k) ?? 0) + 1);
    const entry = this.pool.get(k);
    if (entry) entry.pins++;
  }

  unpin(agentName: string, conversationId: string): void {
    const k = this.key(agentName, conversationId);
    const current = this.legacyPins.get(k) ?? 0;
    if (current > 1) this.legacyPins.set(k, current - 1);
    else this.legacyPins.delete(k);
    const entry = this.pool.get(k);
    if (entry && current > 0) entry.pins--;
  }

  get(agentName: string, conversationId: string): PoolEntry | undefined {
    return this.pool.get(this.key(agentName, conversationId));
  }

  has(agentName: string, conversationId: string): boolean {
    return this.pool.has(this.key(agentName, conversationId));
  }

  /**
   * Drop one idle conversation entry so the next acquisition rebuilds it.
   * The entry is detached synchronously; a same-key create waits for stop().
   */
  dropConversation(agentName: string, conversationId: string): boolean {
    const key = this.key(agentName, conversationId);
    const entry = this.pool.get(key);
    if (!entry || entry.pins > 0) return false;
    const retired = this.retireEntry(key);
    if (!retired) return false;
    const retiring = this.beginRetirement(retired);
    void Promise.resolve(retired.entry.backend.stop())
      .catch((error) => {
        retiring.error = error;
      })
      .finally(() => {
        if (this.retiring.get(retiring.key) === retiring) this.retiring.delete(retiring.key);
        retiring.resolve();
      });
    return true;
  }

  evictAgent(agentName: string): Promise<void> {
    if (this.processRetirement) return this.processRetirement;
    const activeRetirement = this.agentRetirements.get(agentName);
    if (activeRetirement) return activeRetirement;

    this.retiringAgents.add(agentName);
    this.agentEpochs.set(agentName, (this.agentEpochs.get(agentName) ?? 0) + 1);
    const retirement = (async () => {
      try {
        const errors = await this.drainMatching((candidate) => candidate === agentName, true);
        if (errors.length > 0) throw errors[0];
      } finally {
        this.retiringAgents.delete(agentName);
        this.agentRetirements.delete(agentName);
      }
    })();
    this.agentRetirements.set(agentName, retirement);
    return retirement;
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
      if (entry.pins > 0) continue;
      const retired = this.retireEntry(key);
      if (retired) toEvict.push(retired.entry);
    }
    const errors = (await Promise.all(toEvict.map((entry) => this.stopEntry(entry, false)))).flat();
    if (errors.length > 0) throw errors[0];
  }

  /**
   * Synchronously interrupt every pinned backend without retiring pool state.
   * Process shutdown uses this to unwind ingress-holding streams before its
   * fixed admission drain; full disposal remains owned by {@link clear} after
   * already-admitted maintenance mutations have settled.
   */
  interruptAll(): void {
    const errors: unknown[] = [];
    for (const entry of this.pool.values()) {
      if (entry.pins <= 0) continue;
      try {
        entry.backend.abort();
      } catch (error) {
        errors.push(error);
      }
    }
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

  clear(): Promise<void> {
    if (this.processRetirement) return this.processRetirement;

    this.processRetiring = true;
    this.processEpoch++;
    const priorAgentRetirements = [...this.agentRetirements.values()];
    const retirement = (async () => {
      try {
        const [errors, priorResults] = await Promise.all([
          this.drainMatching(() => true, false),
          Promise.allSettled(priorAgentRetirements),
        ]);
        errors.push(
          ...priorResults.flatMap((result) =>
            result.status === 'rejected' ? [result.reason] : [],
          ),
        );
        if (errors.length > 0) throw errors[0];
      } finally {
        this.processRetiring = false;
        this.processRetirement = undefined;
      }
    })();
    this.processRetirement = retirement;
    return retirement;
  }

  private async drainMatching(
    matchesAgent: (agentName: string) => boolean,
    abortPinned: boolean,
  ): Promise<unknown[]> {
    const errors: unknown[] = [];
    while (true) {
      const entries: PoolEntry[] = [];
      for (const [key] of this.pool) {
        const agentName = this.entryAgents.get(key) ?? key.split('/')[0];
        if (!matchesAgent(agentName)) continue;
        const retired = this.retireEntry(key);
        if (retired) entries.push(retired.entry);
      }
      const pending = this.retirePending((creation) => matchesAgent(creation.agentName));
      const retirements = [...this.retiring.values()].filter((retirement) =>
        matchesAgent(retirement.agentName),
      );
      if (entries.length === 0 && pending.length === 0 && retirements.length === 0) break;
      const [entryErrors, pendingErrors, retirementErrors] = await Promise.all([
        Promise.all(entries.map((entry) => this.stopEntry(entry, abortPinned))),
        this.awaitRetiredCreations(pending),
        this.awaitRetirements(retirements),
      ]);
      errors.push(...entryErrors.flat(), ...pendingErrors, ...retirementErrors);
    }
    return errors;
  }

  stats(): { size: number; maxSize: number; pinned: number; agents: Record<string, number> } {
    const agents: Record<string, number> = {};
    let pinned = 0;
    for (const [key, entry] of this.pool) {
      const agentName = key.split('/')[0];
      agents[agentName] = (agents[agentName] ?? 0) + 1;
      if (entry.pins > 0) pinned++;
    }
    return { size: this.pool.size, maxSize: this.maxSize, pinned, agents };
  }
}
