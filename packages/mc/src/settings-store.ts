import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MobileCapability } from '@dash/mobile-contract';

export interface AppSettings {
  defaultModel?: string;
  defaultFallbackModels?: string[];
  setupCompletedAt?: string;
  /** Persisted top-left position of the always-on-top companion widget window. */
  companionWindowPos?: { x: number; y: number };
  /**
   * Non-secret gateway connection profile for Mission Control. Secrets for
   * remote profiles live in the OS keychain.
   */
  gatewayConnection?: GatewayConnectionSettings;
}

export type GatewayConnectionMode = 'local' | 'relay' | 'hosted';

export interface GatewayConnectionSettings {
  mode: GatewayConnectionMode;
  name?: string;
  managementBaseUrl?: string;
  chatBaseUrl?: string;
  updatedAt?: string;
  gatewayId?: string;
  apiVersion?: number;
  capabilities?: MobileCapability[];
}

export class SettingsStore {
  private filePath: string;
  /** Serializes read-modify-write cycles so overlapping `set` calls don't drop keys. */
  private writeChain: Promise<void> = Promise.resolve();

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
    // Chain the read-modify-write onto the tail so concurrent `set` calls run
    // strictly sequentially and neither drops the other's keys. Returning the
    // new tail keeps `await store.set(...)` meaning "my write has landed".
    const next = this.writeChain.then(async () => {
      const current = await this.get();
      const updated = { ...current, ...patch };
      await writeFile(this.filePath, JSON.stringify(updated, null, 2));
    });
    // Swallow rejection on the stored tail so one failed write doesn't poison
    // every subsequent `set`; the caller still sees the error via `next`.
    this.writeChain = next.catch(() => {});
    return next;
  }
}
