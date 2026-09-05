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

export type PoolBackendFactory = (
  agentName: string,
  conversationId: string,
) => Promise<{ backend: AgentBackend; agent: DashAgent }>;

export interface ConversationPoolOptions {
  maxSize: number;
  backendFactory: PoolBackendFactory;
}

export class ConversationPool {
  private pool = new Map<string, PoolEntry>();
  private pending = new Map<string, Promise<PoolEntry>>();
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

    const promise = this.createEntry(k, agentName, conversationId);
    this.pending.set(k, promise);
    try {
      return await promise;
    } finally {
      this.pending.delete(k);
    }
  }

  private async createEntry(
    k: string,
    agentName: string,
    conversationId: string,
  ): Promise<PoolEntry> {
    if (this.pool.size >= this.maxSize) {
      const evicted = await this.evictLRU();
      if (!evicted) {
        throw new Error(
          `Pool is full (${this.maxSize} entries, all pinned). Cannot create new conversation.`,
        );
      }
    }

    const { backend, agent } = await this.backendFactory(agentName, conversationId);
    const entry: PoolEntry = {
      backend,
      agent,
      lastActive: Date.now(),
      pins: 0,
    };
    this.pool.set(k, entry);
    return entry;
  }

  private async evictLRU(): Promise<boolean> {
    let oldest: { key: string; time: number } | null = null;
    for (const [key, entry] of this.pool) {
      if (entry.pins > 0) continue;
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
    const entry = this.pool.get(this.key(agentName, conversationId));
    if (entry) entry.pins++;
  }

  unpin(agentName: string, conversationId: string): void {
    const entry = this.pool.get(this.key(agentName, conversationId));
    if (entry && entry.pins > 0) entry.pins--;
  }

  get(agentName: string, conversationId: string): PoolEntry | undefined {
    return this.pool.get(this.key(agentName, conversationId));
  }

  has(agentName: string, conversationId: string): boolean {
    return this.pool.has(this.key(agentName, conversationId));
  }

  /**
   * Drop ONE conversation's warm entry so the next `getOrCreate` rebuilds it.
   *
   * The map delete is SYNCHRONOUS and `stop()` is fired without awaiting: the
   * caller's very next `getOrCreate` has to miss, and making that depend on a
   * backend settling would reopen the window this closes. A PINNED entry (a
   * turn in flight) is left alone — it is mid-stream, and the next turn will
   * re-check.
   *
   * Returns whether an entry was dropped.
   */
  dropConversation(agentName: string, conversationId: string): boolean {
    const k = this.key(agentName, conversationId);
    const entry = this.pool.get(k);
    // NEVER drop an entry with a live turn on it: `stop()` would be called on a
    // backend that is still streaming. The caller decides what to do with the
    // refusal — it must not assume the entry was replaced.
    if (!entry || entry.pins > 0) return false;
    this.pool.delete(k);
    void Promise.resolve(entry.backend.stop()).catch(() => {});
    return true;
  }

  async evictAgent(agentName: string): Promise<void> {
    const prefix = `${agentName}/`;
    const toEvict: string[] = [];
    for (const [key, entry] of this.pool) {
      if (key.startsWith(prefix)) {
        if (entry.pins > 0) {
          entry.backend.abort();
        }
        await entry.backend.stop();
        toEvict.push(key);
      }
    }
    for (const key of toEvict) {
      this.pool.delete(key);
    }
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
      if (entry.pins > 0) continue;
      await entry.backend.stop();
      toEvict.push(key);
    }
    for (const key of toEvict) {
      this.pool.delete(key);
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
    for (const entry of this.pool.values()) {
      await entry.backend.stop();
    }
    this.pool.clear();
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
