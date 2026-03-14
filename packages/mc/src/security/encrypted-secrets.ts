import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { EncryptedPayload } from './crypto.js';
import { decrypt, deriveKey, encrypt, generateSalt } from './crypto.js';
import type { SecretStore } from './secrets.js';

const MIN_PASSWORD_LENGTH = 8;

export interface LockableSecretStore extends SecretStore {
  unlock(derivedKey: Buffer): void;
  lock(): void;
  isUnlocked(): boolean;
  needsSetup(): Promise<boolean>;
  needsMigration(): Promise<boolean>;
  setup(password: string): Promise<Buffer>;
  unlockWithPassword(password: string): Promise<Buffer>;
  changePassword(currentPassword: string, newPassword: string): Promise<Buffer>;
}

export class EncryptedSecretStore implements LockableSecretStore {
  private encPath: string;
  private plainPath: string;
  private key: Buffer | null = null;
  private salt: Buffer | null = null;

  constructor(dataDir: string) {
    this.encPath = join(dataDir, 'secrets.enc');
    this.plainPath = join(dataDir, 'secrets.json');
  }

  unlock(derivedKey: Buffer): void {
    this.key = derivedKey;
    // Salt will be read from file on first load if not already set
  }

  lock(): void {
    this.key = null;
    this.salt = null;
  }

  isUnlocked(): boolean {
    return this.key !== null;
  }

  async needsSetup(): Promise<boolean> {
    return !existsSync(this.encPath);
  }

  async needsMigration(): Promise<boolean> {
    return existsSync(this.plainPath) && !existsSync(this.encPath);
  }

  async setup(password: string): Promise<Buffer> {
    if (existsSync(this.encPath)) {
      throw new Error(
        'Encrypted secrets store already exists. Use unlockWithPassword() to unlock it.',
      );
    }
    this.validatePassword(password);

    const salt = generateSalt();
    const key = deriveKey(password, salt);

    // Migrate existing plaintext secrets if present
    let secrets: Record<string, string> = {};
    if (existsSync(this.plainPath)) {
      const raw = await readFile(this.plainPath, 'utf-8');
      secrets = JSON.parse(raw) as Record<string, string>;
    }

    this.key = key;
    this.salt = salt;
    await this.save(secrets);

    // Delete plaintext file after successful encryption
    if (existsSync(this.plainPath)) {
      await rm(this.plainPath);
    }

    return key;
  }

  async unlockWithPassword(password: string): Promise<Buffer> {
    const raw = await readFile(this.encPath, 'utf-8');
    const payload = JSON.parse(raw) as EncryptedPayload;
    const salt = Buffer.from(payload.salt, 'base64');
    const key = deriveKey(password, salt);

    // Validate by trial decryption — throws if wrong password
    decrypt(payload, key);

    this.key = key;
    this.salt = salt;
    return key;
  }

  async changePassword(currentPassword: string, newPassword: string): Promise<Buffer> {
    this.validatePassword(newPassword);

    // Validate current password
    const raw = await readFile(this.encPath, 'utf-8');
    const payload = JSON.parse(raw) as EncryptedPayload;
    const oldSalt = Buffer.from(payload.salt, 'base64');
    const oldKey = deriveKey(currentPassword, oldSalt);
    decrypt(payload, oldKey);

    // Load secrets with old key
    this.key = oldKey;
    this.salt = oldSalt;
    const secrets = await this.load();

    // Re-encrypt with new key
    const newSalt = generateSalt();
    const newKey = deriveKey(newPassword, newSalt);
    this.key = newKey;
    this.salt = newSalt;
    await this.save(secrets);

    return newKey;
  }

  async get(key: string): Promise<string | null> {
    this.assertUnlocked();
    const secrets = await this.load();
    return secrets[key] ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.assertUnlocked();
    const secrets = await this.load();
    secrets[key] = value;
    await this.save(secrets);
  }

  async delete(key: string): Promise<void> {
    this.assertUnlocked();
    const secrets = await this.load();
    delete secrets[key];
    await this.save(secrets);
  }

  async list(): Promise<string[]> {
    this.assertUnlocked();
    const secrets = await this.load();
    return Object.keys(secrets);
  }

  private validatePassword(password: string): void {
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    }
  }

  private assertUnlocked(): void {
    if (!this.key) {
      throw new Error('Secret store is locked');
    }
  }

  private async load(): Promise<Record<string, string>> {
    if (!existsSync(this.encPath)) return {};
    const raw = await readFile(this.encPath, 'utf-8');
    const payload = JSON.parse(raw) as EncryptedPayload;
    // Ensure salt is loaded for unlock() callers who only have the key
    if (!this.salt) {
      this.salt = Buffer.from(payload.salt, 'base64');
    }
    const key = this.key as Buffer;
    const plaintext = decrypt(payload, key);
    return JSON.parse(plaintext) as Record<string, string>;
  }

  private async save(secrets: Record<string, string>): Promise<void> {
    await mkdir(dirname(this.encPath), { recursive: true });
    const key = this.key as Buffer;
    const salt = this.salt as Buffer;
    const payload = encrypt(JSON.stringify(secrets), key, salt);
    // Atomic write: write to temp file, then rename. rename() is atomic on POSIX,
    // so a crash mid-write leaves the old file intact rather than corrupting it.
    const tmpPath = `${this.encPath}.tmp`;
    await writeFile(tmpPath, JSON.stringify(payload, null, 2), { mode: 0o600 });
    await chmod(tmpPath, 0o600);
    await rename(tmpPath, this.encPath);
  }
}
