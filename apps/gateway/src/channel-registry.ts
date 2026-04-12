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
  /**
   * Optional adapter-level allow-list. When non-empty, the channel adapter
   * itself rejects messages from senders that aren't on this list and sends
   * an "unauthorized" reply. Distinct from rule-level `allowList` in two
   * ways: (a) it runs BEFORE routing, so unauthorized senders never hit the
   * agent pool or the audit log's routed path; (b) for Telegram it matches
   * by numeric ID, bare username, or `@username`, not just sender ID.
   *
   * Leave empty (or omit) to forward every message to the routing layer and
   * let rule-level `allowList` / `globalDenyList` do the filtering.
   */
  allowedUsers?: string[];
  routing: ChannelRoutingRule[];
}

export interface RegisteredChannel {
  name: string;
  adapter: 'telegram' | 'whatsapp';
  globalDenyList: string[];
  allowedUsers: string[];
  routing: ChannelRoutingRule[];
  registeredAt: string; // ISO timestamp
}

export class ChannelRegistry {
  private channels = new Map<string, RegisteredChannel>();

  constructor(private filePath?: string) {}

  /** Load persisted channels from disk. No-op if no file path or file doesn't exist. */
  async load(): Promise<void> {
    if (!this.filePath) return;
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf-8');
    } catch (err) {
      // Missing file is the normal "first boot" case — stay silent.
      // Any other read error is worth surfacing.
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        console.warn(
          `[channel-registry] failed to read ${this.filePath}:`,
          err instanceof Error ? err.message : err,
        );
      }
      return;
    }
    try {
      const entries = JSON.parse(raw) as RegisteredChannel[];
      this.channels.clear();
      for (const entry of entries) {
        // Forward-compat: older channels.json files written before
        // `allowedUsers` existed will not have the field. Normalize to an
        // empty array so the field is always present in memory.
        if (!Array.isArray(entry.allowedUsers)) {
          entry.allowedUsers = [];
        }
        this.channels.set(entry.name, entry);
      }
    } catch (err) {
      // Corrupt JSON — do NOT silently reset to empty. Refuse to overwrite
      // the file on the next save() by leaving the in-memory state empty
      // while making the problem loud. An operator should move the file
      // aside before restarting.
      console.error(
        `[channel-registry] ${this.filePath} is corrupt and could not be parsed — starting with empty channel list (file preserved):`,
        err instanceof Error ? err.message : err,
      );
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
      allowedUsers: config.allowedUsers ?? [],
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
    if (patch.allowedUsers !== undefined) entry.allowedUsers = patch.allowedUsers;
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
