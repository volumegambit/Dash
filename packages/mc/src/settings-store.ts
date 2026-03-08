import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface AppSettings {
  defaultModel?: string;
  defaultFallbackModels?: string[];
}

export class SettingsStore {
  private filePath: string;

  constructor(dataDir: string) {
    this.filePath = join(dataDir, 'settings.json');
  }

  async get(): Promise<AppSettings> {
    if (!existsSync(this.filePath)) return {};
    const raw = await readFile(this.filePath, 'utf-8');
    return JSON.parse(raw) as AppSettings;
  }

  async set(patch: Partial<AppSettings>): Promise<void> {
    const current = await this.get();
    const updated = { ...current, ...patch };
    await writeFile(this.filePath, JSON.stringify(updated, null, 2));
  }
}
