import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { PluginEntryConfig } from './types.js';

/**
 * Persistence for the plugins enable/trust block at
 * <dataDir>/plugins/config.json. load() tolerates a missing or corrupt file
 * (returns {}); writes are atomic (temp + rename).
 */
/**
 * Dangerous keys that must never become entry names: assigning
 * `entries['__proto__'] = {...}` reparents the map (its prototype becomes the
 * attacker object), which would make it inherit enabled/trusted and silently
 * bypass the trust gate. `load()` already skips these; the setters guard them
 * too (defense-in-depth — not currently route-reachable).
 */
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export class PluginConfigStore {
  private readonly filePath: string;
  /**
   * Single in-process write queue. Every mutation (setEnabled/setTrusted/remove)
   * chains onto this promise so each load→mutate→save runs against the freshest
   * on-disk state — concurrent writes can no longer clobber each other's keys
   * (the atomic temp+rename prevents file corruption, not lost updates). The
   * queue never rejects (errors propagate to the awaiting caller while the chain
   * itself resolves) so one failed write does not wedge later writes.
   */
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.filePath = join(dataDir, 'plugins', 'config.json');
  }

  /**
   * Serialize a read-modify-write against the on-disk config behind the write
   * queue. Returns a promise that settles with `fn`'s outcome; the internal
   * chain absorbs the rejection so a failed write never blocks subsequent ones.
   */
  private enqueue(fn: () => Promise<void>): Promise<void> {
    const run = this.writeQueue.then(fn, fn);
    // Keep the chain alive (and non-rejecting) regardless of fn's outcome.
    this.writeQueue = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  async load(): Promise<Record<string, PluginEntryConfig>> {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(this.filePath, 'utf8'));
    } catch {
      return {};
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
    const entries: Record<string, PluginEntryConfig> = {};
    for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
      // Skip dangerous keys (see DANGEROUS_KEYS): a `__proto__` own-key would
      // reparent the map and silently bypass the trust gate.
      if (DANGEROUS_KEYS.has(name)) continue;
      if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
      const v = value as Record<string, unknown>;
      entries[name] = {
        enabled: v.enabled === true,
        trusted: v.trusted === true ? true : undefined,
        config:
          typeof v.config === 'object' && v.config !== null && !Array.isArray(v.config)
            ? (v.config as Record<string, unknown>)
            : undefined,
        path: typeof v.path === 'string' ? v.path : undefined,
        installed: v.installed === true ? true : undefined,
        source: typeof v.source === 'string' ? v.source : undefined,
      };
    }
    return entries;
  }

  async setEnabled(name: string, enabled: boolean): Promise<void> {
    if (DANGEROUS_KEYS.has(name)) return;
    return this.enqueue(async () => {
      const entries = await this.load();
      entries[name] = { ...(entries[name] ?? { enabled: false }), enabled };
      await this.save(entries);
    });
  }

  async setTrusted(name: string, trusted: boolean): Promise<void> {
    if (DANGEROUS_KEYS.has(name)) return;
    return this.enqueue(async () => {
      const entries = await this.load();
      entries[name] = { ...(entries[name] ?? { enabled: false }), trusted };
      await this.save(entries);
    });
  }

  /**
   * Record where a plugin was installed from (the original install `source`
   * string). Set by the API install endpoint for reinstall/update; mirrors
   * `setEnabled` (write-queue serialized, name guarded, load→mutate→save).
   */
  async setSource(name: string, source: string): Promise<void> {
    if (DANGEROUS_KEYS.has(name)) return;
    return this.enqueue(async () => {
      const entries = await this.load();
      entries[name] = { ...(entries[name] ?? { enabled: false }), source };
      await this.save(entries);
    });
  }

  /**
   * Mark whether a plugin was installed by the management API into
   * `<dataDir>/plugins/<name>`. Gates DELETE's directory removal. Mirrors
   * `setEnabled` (write-queue serialized, name guarded, load→mutate→save).
   */
  async setInstalled(name: string, installed: boolean): Promise<void> {
    if (DANGEROUS_KEYS.has(name)) return;
    return this.enqueue(async () => {
      const entries = await this.load();
      entries[name] = { ...(entries[name] ?? { enabled: false }), installed };
      await this.save(entries);
    });
  }

  /**
   * Delete a plugin's enable/trust entry from the config. No-op (still
   * persists) when the name is absent. Serialized behind the write queue and
   * using the same atomic temp+rename pattern as the setters so a concurrent
   * save() can neither corrupt the file nor lose another write's update.
   */
  async remove(name: string): Promise<void> {
    if (DANGEROUS_KEYS.has(name)) return;
    return this.enqueue(async () => {
      const entries = await this.load();
      delete entries[name];
      await this.save(entries);
    });
  }

  private async save(entries: Record<string, PluginEntryConfig>): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    // Randomize the temp path so concurrent save()s don't write the same file and
    // corrupt/interleave each other's contents before rename.
    const tmpPath = `${this.filePath}.${randomUUID()}.tmp`;
    await writeFile(tmpPath, JSON.stringify(entries, null, 2));
    try {
      await rename(tmpPath, this.filePath);
    } catch (err) {
      // Don't leave the temp file behind if the rename fails.
      await unlink(tmpPath).catch(() => {});
      throw err;
    }
  }
}
