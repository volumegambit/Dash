import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { TokenStore } from './types.js';

/**
 * File-based TokenStore with 0600 permissions and atomic writes.
 * Lazy-loads from disk on first access, caches in memory, flushes on every write.
 * All mutations are serialized through a write queue to prevent concurrent corruption.
 */
export class FileTokenStore implements TokenStore {
  private cache: Map<string, string> | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async get(key: string): Promise<string | undefined> {
    await this.ensureLoaded();
    return this.cache?.get(key);
  }

  async set(key: string, value: string): Promise<void> {
    // Serialize mutations to prevent concurrent cache/file issues
    const p = this.writeQueue.then(async () => {
      await this.ensureLoaded();
      this.cache?.set(key, value);
      await this.doFlush();
    });
    this.writeQueue = p.catch(() => {}); // Don't let errors break the chain
    return p;
  }

  async delete(key: string): Promise<void> {
    const p = this.writeQueue.then(async () => {
      await this.ensureLoaded();
      this.cache?.delete(key);
      await this.doFlush();
    });
    this.writeQueue = p.catch(() => {});
    return p;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.cache) return;
    try {
      const raw = await readFile(this.filePath, 'utf-8');
      const data = JSON.parse(raw) as Record<string, string>;
      this.cache = new Map(Object.entries(data));
    } catch {
      this.cache = new Map();
    }
  }

  private async doFlush(): Promise<void> {
    if (!this.cache) return;
    const data = Object.fromEntries(this.cache);
    const json = JSON.stringify(data, null, 2);
    const tmpPath = `${this.filePath}.tmp`;

    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(tmpPath, json, { mode: 0o600 });
    await rename(tmpPath, this.filePath);
    await chmod(this.filePath, 0o600);
  }
}
