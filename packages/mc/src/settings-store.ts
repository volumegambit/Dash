import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface AppSettings {
  defaultModel?: string;
  defaultFallbackModels?: string[];
  setupCompletedAt?: string;
  /**
   * Relay domain for remote access, e.g. `relay.example.com`. When set (together
   * with a relay token + admin secret in the keychain), the gateway is launched
   * in relay mode and Pair Device produces a relay QR. Non-secret, so it lives
   * here rather than the keychain. A gateway is reachable at `<gatewayId>.<zone>`.
   */
  relayZone?: string;
}

export class SettingsStore {
  private filePath: string;

  constructor(dataDir: string) {
    this.filePath = join(dataDir, 'settings.json');
  }

  async get(): Promise<AppSettings> {
    if (!existsSync(this.filePath)) return {};
    try {
      const raw = await readFile(this.filePath, 'utf-8');
      if (!raw.trim()) return {};
      return JSON.parse(raw) as AppSettings;
    } catch {
      return {};
    }
  }

  async set(patch: Partial<AppSettings>): Promise<void> {
    const current = await this.get();
    const updated = { ...current, ...patch };
    await writeFile(this.filePath, JSON.stringify(updated, null, 2));
  }
}
