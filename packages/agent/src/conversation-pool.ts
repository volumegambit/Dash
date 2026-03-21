import type { DashAgent } from './agent.js';
import type { AgentBackend } from './types.js';

export interface PoolEntry {
  backend: AgentBackend;
  agent: DashAgent;
  lastActive: number;
  pinned: boolean;
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
      pinned: false,
    };
    this.pool.set(k, entry);
    return entry;
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
    const entry = this.pool.get(this.key(agentName, conversationId));
    if (entry) entry.pinned = true;
  }

  unpin(agentName: string, conversationId: string): void {
    const entry = this.pool.get(this.key(agentName, conversationId));
    if (entry) entry.pinned = false;
  }

  get(agentName: string, conversationId: string): PoolEntry | undefined {
    return this.pool.get(this.key(agentName, conversationId));
  }

  has(agentName: string, conversationId: string): boolean {
    return this.pool.has(this.key(agentName, conversationId));
  }

  async evictAgent(agentName: string): Promise<void> {
    const prefix = `${agentName}/`;
    const toEvict: string[] = [];
    for (const [key, entry] of this.pool) {
      if (key.startsWith(prefix)) {
        if (entry.pinned) {
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
      if (entry.pinned) pinned++;
    }
    return { size: this.pool.size, maxSize: this.maxSize, pinned, agents };
  }
}
