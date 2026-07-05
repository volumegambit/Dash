import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
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
  /**
   * Single in-process write queue. `set()` / `delete()` are read-modify-writes
   * (load → mutate → save), so they must serialize the WHOLE critical section,
   * not just the file write — two overlapping mutations that each `load()` the
   * same on-disk map and then save would otherwise lose one another's update
   * (last-writer-wins clobbers the earlier key change). Chaining them behind
   * this queue makes each run against the freshest on-disk state. The queue
   * never rejects (a failed write propagates to the awaiting caller while the
   * chain stays resolved) so one failure does not wedge later writes. Mirrors
   * `PluginConfigStore`.
   */
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private dataDir: string) {
    this.keyPath = join(dataDir, 'secret.key');
    this.encPath = join(dataDir, 'credentials.enc');
  }

  /**
   * Serialize a read-modify-write against the on-disk credentials behind the
   * write queue. Returns a promise that settles with `fn`'s outcome; the chain
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
      // Unique temp name so a concurrent init/write can't share this `.tmp`.
      const tmpPath = `${this.keyPath}.${randomUUID()}.tmp`;
      await writeFile(tmpPath, payload, { mode: 0o600 });
      await chmod(tmpPath, 0o600);
      try {
        await rename(tmpPath, this.keyPath);
      } catch (err) {
        await unlink(tmpPath).catch(() => {});
        throw err;
      }
    }
  }

  async get(key: string): Promise<string | null> {
    const secrets = await this.load();
    return secrets[key] ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    // Serialize the whole load→mutate→save so a concurrent set/delete can't
    // read a stale map and clobber this key (see writeQueue).
    return this.enqueue(async () => {
      const secrets = await this.load();
      secrets[key] = value;
      await this.save(secrets);
    });
  }

  async delete(key: string): Promise<void> {
    return this.enqueue(async () => {
      const secrets = await this.load();
      delete secrets[key];
      await this.save(secrets);
    });
  }

  async list(): Promise<string[]> {
    const secrets = await this.load();
    return Object.keys(secrets);
  }

  /**
   * Read all `{provider}-api-key:{keyName}` entries and collapse them into
   * a single `{ provider: value }` map. The first matching key per provider
   * wins (matching what `createBackend` does at agent spawn time).
   */
  async readProviderApiKeys(): Promise<Record<string, string>> {
    const secrets = await this.load();
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(secrets)) {
      const match = key.match(/^(.+)-api-key:(.+)$/);
      if (!match) continue;
      const provider = match[1];
      if (!out[provider] && value) {
        out[provider] = value;
      }
    }
    return out;
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
    // Randomize the temp path so concurrent saves don't write the same file and
    // corrupt/interleave each other's contents (or ENOENT on the loser's
    // rename after the winner already consumed a shared `.tmp`).
    const tmpPath = `${this.encPath}.${randomUUID()}.tmp`;
    await writeFile(tmpPath, JSON.stringify(payload, null, 2), { mode: 0o600 });
    await chmod(tmpPath, 0o600);
    try {
      await rename(tmpPath, this.encPath);
    } catch (err) {
      // Don't leave the temp file behind if the rename fails.
      await unlink(tmpPath).catch(() => {});
      throw err;
    }
  }
}
