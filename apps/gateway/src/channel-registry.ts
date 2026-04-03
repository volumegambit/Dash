import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface ChannelRoutingRule {
  condition:
    | { type: 'default' }
    | { type: 'sender'; ids: string[] }
    | { type: 'group'; ids: string[] };
  agentId: string;
  allowList: string[];
  denyList: string[];
}

export interface ChannelConfig {
  name: string;
  adapter: 'telegram' | 'whatsapp';
  globalDenyList: string[];
  routing: ChannelRoutingRule[];
}

export interface RegisteredChannel {
  name: string;
  adapter: 'telegram' | 'whatsapp';
  globalDenyList: string[];
  routing: ChannelRoutingRule[];
  registeredAt: string; // ISO timestamp
}

export class ChannelRegistry {
  private channels = new Map<string, RegisteredChannel>();

  constructor(private filePath?: string) {}

  /** Load persisted channels from disk. No-op if no file path or file doesn't exist. */
  async load(): Promise<void> {
    if (!this.filePath) return;
    try {
      const raw = await readFile(this.filePath, 'utf-8');
      const entries = JSON.parse(raw) as RegisteredChannel[];
      this.channels.clear();
      for (const entry of entries) {
        this.channels.set(entry.name, entry);
      }
    } catch {
      // File doesn't exist or is invalid — start empty
    }
  }

  /** Persist current state to disk. No-op if no file path. */
  async save(): Promise<void> {
    if (!this.filePath) return;
    await mkdir(dirname(this.filePath), { recursive: true });
    const entries = [...this.channels.values()];
    const tmpPath = `${this.filePath}.tmp`;
    await writeFile(tmpPath, JSON.stringify(entries, null, 2));
    await rename(tmpPath, this.filePath);
  }

  register(config: ChannelConfig): RegisteredChannel {
    const entry: RegisteredChannel = {
      name: config.name,
      adapter: config.adapter,
      globalDenyList: config.globalDenyList,
      routing: config.routing,
      registeredAt: new Date().toISOString(),
    };
    this.channels.set(config.name, entry);
    return entry;
  }

  get(name: string): RegisteredChannel | undefined {
    return this.channels.get(name);
  }

  list(): RegisteredChannel[] {
    return [...this.channels.values()];
  }

  update(name: string, patch: Partial<Omit<ChannelConfig, 'name'>>): RegisteredChannel {
    const entry = this.channels.get(name);
    if (!entry) throw new Error(`Channel '${name}' not found`);
    if (patch.adapter !== undefined) entry.adapter = patch.adapter;
    if (patch.globalDenyList !== undefined) entry.globalDenyList = patch.globalDenyList;
    if (patch.routing !== undefined) entry.routing = patch.routing;
    return entry;
  }

  remove(name: string): boolean {
    return this.channels.delete(name);
  }

  /**
   * Removes routing rules that reference the given agentId from all channels.
   * If a channel ends up with no routing rules, it is removed entirely.
   * Returns the names of channels that were fully removed.
   */
  removeRoutesForAgent(agentId: string): string[] {
    const removed: string[] = [];
    for (const [name, channel] of this.channels) {
      channel.routing = channel.routing.filter((rule) => rule.agentId !== agentId);
      if (channel.routing.length === 0) {
        this.channels.delete(name);
        removed.push(name);
      }
    }
    return removed;
  }

  has(name: string): boolean {
    return this.channels.has(name);
  }
}
