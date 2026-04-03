import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { EncryptedPayload } from './crypto.js';
import { decrypt, deriveKey, encrypt, generateSalt } from './crypto.js';

/**
 * Encrypted credential store for the gateway.
 *
 * Uses a random key persisted in `secret.key` (0600 permissions).
 * Credentials are stored in `credentials.enc` as AES-256-GCM encrypted JSON.
 */
export class GatewayCredentialStore {
  private keyPath: string;
  private encPath: string;
  private key: Buffer | null = null;
  private salt: Buffer | null = null;

  constructor(private dataDir: string) {
    this.keyPath = join(dataDir, 'secret.key');
    this.encPath = join(dataDir, 'credentials.enc');
  }

  async init(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    if (existsSync(this.keyPath)) {
      const raw = await readFile(this.keyPath, 'utf-8');
      const parsed = JSON.parse(raw) as { key: string; salt: string };
      this.key = Buffer.from(parsed.key, 'base64');
      this.salt = Buffer.from(parsed.salt, 'base64');
    } else {
      const password = randomBytes(32).toString('base64');
      this.salt = generateSalt();
      this.key = deriveKey(password, this.salt);
      const payload = JSON.stringify({
        key: this.key.toString('base64'),
        salt: this.salt.toString('base64'),
      });
      const tmpPath = `${this.keyPath}.tmp`;
      await writeFile(tmpPath, payload, { mode: 0o600 });
      await chmod(tmpPath, 0o600);
      await rename(tmpPath, this.keyPath);
    }
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

  private async load(): Promise<Record<string, string>> {
    if (!existsSync(this.encPath)) return {};
    const raw = await readFile(this.encPath, 'utf-8');
    if (!raw.trim()) return {};
    const payload = JSON.parse(raw) as EncryptedPayload;
    const plaintext = decrypt(payload, this.key as Buffer);
    return JSON.parse(plaintext) as Record<string, string>;
  }

  private async save(secrets: Record<string, string>): Promise<void> {
    await mkdir(dirname(this.encPath), { recursive: true });
    const payload = encrypt(JSON.stringify(secrets), this.key as Buffer, this.salt as Buffer);
    const tmpPath = `${this.encPath}.tmp`;
    await writeFile(tmpPath, JSON.stringify(payload, null, 2), { mode: 0o600 });
    await chmod(tmpPath, 0o600);
    await rename(tmpPath, this.encPath);
  }
}
