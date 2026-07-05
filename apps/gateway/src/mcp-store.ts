import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { McpConfigStoreInterface, McpServerConfig } from '@dash/mcp';

/**
 * Persists MCP server configs and allowlist to the gateway's data directory.
 * All files are written with 0600 permissions using atomic writes. Mutations
 * are serialized behind a write queue: add/remove are load→mutate→save cycles,
 * so without it two concurrent calls would read the same stale snapshot and
 * silently drop one config (and race the temp-file rename).
 */
export class McpConfigStore implements McpConfigStoreInterface {
  private readonly configsPath: string;
  private readonly allowlistPath: string;
  /**
   * Single in-process write queue. Every mutation chains onto this promise so
   * whole read-modify-write cycles run against the freshest on-disk state. The
   * queue never rejects — a failed write propagates to its awaiting caller
   * while the chain stays resolved so it does not wedge later writes. Mirrors
   * `GatewayCredentialStore` / `PluginConfigStore`.
   */
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly mcpDir: string) {
    this.configsPath = join(mcpDir, 'configs.json');
    this.allowlistPath = join(mcpDir, 'allowlist.json');
  }

  /**
   * Serialize a write (or a whole read-modify-write cycle) behind the write
   * queue. Returns a promise that settles with `fn`'s outcome; the chain
   * absorbs the rejection so a failed write never blocks subsequent ones.
   */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.writeQueue.then(fn, fn);
    this.writeQueue = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  async loadConfigs(): Promise<McpServerConfig[]> {
    try {
      const raw = await readFile(this.configsPath, 'utf-8');
      return JSON.parse(raw) as McpServerConfig[];
    } catch {
      return [];
    }
  }

  async saveConfigs(configs: McpServerConfig[]): Promise<void> {
    await this.enqueue(() => this.writeConfigs(configs));
  }

  async addConfig(config: McpServerConfig): Promise<void> {
    // The whole load→check→save cycle runs under the queue so the duplicate
    // check and the write see the same state (calling the public saveConfigs
    // here would re-enter the queue and deadlock — use the raw write).
    await this.enqueue(async () => {
      const configs = await this.loadConfigs();
      if (configs.some((c) => c.name === config.name)) {
        throw new Error(`MCP server "${config.name}" already exists`);
      }
      configs.push(config);
      await this.writeConfigs(configs);
    });
  }

  async removeConfig(name: string): Promise<void> {
    await this.enqueue(async () => {
      const configs = await this.loadConfigs();
      const filtered = configs.filter((c) => c.name !== name);
      await this.writeConfigs(filtered);
    });
  }

  private writeConfigs(configs: McpServerConfig[]): Promise<void> {
    return this.atomicWrite(this.configsPath, JSON.stringify(configs, null, 2));
  }

  async loadAllowlist(): Promise<string[]> {
    try {
      const raw = await readFile(this.allowlistPath, 'utf-8');
      return JSON.parse(raw) as string[];
    } catch {
      return [];
    }
  }

  async saveAllowlist(patterns: string[]): Promise<void> {
    const content = JSON.stringify(patterns, null, 2);
    await this.enqueue(() => this.atomicWrite(this.allowlistPath, content));
  }

  /**
   * Check if a URL is allowed by the current allowlist.
   * Empty allowlist means everything is allowed.
   */
  async isAllowed(url: string): Promise<boolean> {
    const patterns = await this.loadAllowlist();
    if (patterns.length === 0) return true;

    for (const pattern of patterns) {
      if (this.matchPattern(pattern, url)) return true;
    }
    return false;
  }

  private matchPattern(pattern: string, url: string): boolean {
    if (pattern === url) return true;
    // Wildcard: convert pattern to regex — escape special chars except *
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`).test(url);
  }

  private async atomicWrite(filePath: string, content: string): Promise<void> {
    await mkdir(this.mcpDir, { recursive: true });
    // Randomize the temp path so concurrent writes don't share a `.tmp` (the
    // loser's rename would ENOENT after the winner already consumed it).
    const tmpPath = `${filePath}.${randomUUID()}.tmp`;
    await writeFile(tmpPath, content, { mode: 0o600 });
    // writeFile's mode is masked by the process umask; enforce it exactly.
    await chmod(tmpPath, 0o600);
    try {
      await rename(tmpPath, filePath);
    } catch (err) {
      // Don't leave the temp file behind if the rename fails.
      await unlink(tmpPath).catch(() => {});
      throw err;
    }
  }
}
