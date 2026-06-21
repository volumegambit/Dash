import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { PluginEntryConfig } from './types.js';

/**
 * Persistence for the plugins enable/trust block at
 * <dataDir>/plugins/config.json. load() tolerates a missing or corrupt file
 * (returns {}); writes are atomic (temp + rename).
 */
export class PluginConfigStore {
  private readonly filePath: string;

  constructor(dataDir: string) {
    this.filePath = join(dataDir, 'plugins', 'config.json');
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
      // Skip dangerous keys: assigning entries['__proto__'] = {...} reparents the
      // map (its prototype becomes the attacker object), which would make it inherit
      // enabled/trusted and silently bypass the trust gate.
      if (name === '__proto__' || name === 'constructor' || name === 'prototype') continue;
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
      };
    }
    return entries;
  }

  async setEnabled(name: string, enabled: boolean): Promise<void> {
    const entries = await this.load();
    entries[name] = { ...(entries[name] ?? { enabled: false }), enabled };
    await this.save(entries);
  }

  async setTrusted(name: string, trusted: boolean): Promise<void> {
    const entries = await this.load();
    entries[name] = { ...(entries[name] ?? { enabled: false }), trusted };
    await this.save(entries);
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
