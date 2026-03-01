import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface SecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  list(): Promise<string[]>;
}

/**
 * File-based secret store. Stores secrets as a JSON object in a file
 * with 0600 permissions (owner read/write only).
 */
export class FileSecretStore implements SecretStore {
  private filePath: string;

  constructor(dataDir: string) {
    this.filePath = join(dataDir, 'secrets.json');
  }

  private async load(): Promise<Record<string, string>> {
    if (!existsSync(this.filePath)) return {};
    const raw = await readFile(this.filePath, 'utf-8');
    return JSON.parse(raw) as Record<string, string>;
  }

  private async save(secrets: Record<string, string>): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(secrets, null, 2), { mode: 0o600 });
    // Ensure permissions even if the file already existed
    await chmod(this.filePath, 0o600);
  }

  async get(key: string): Promise<string | null> {
    const secrets = await this.load();
    return secrets[key] ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    const secrets = await this.load();
    secrets[key] = value;
    await this.save(secrets);
  }

  async delete(key: string): Promise<void> {
    const secrets = await this.load();
    delete secrets[key];
    await this.save(secrets);
  }

  async list(): Promise<string[]> {
    const secrets = await this.load();
    return Object.keys(secrets);
  }
}
