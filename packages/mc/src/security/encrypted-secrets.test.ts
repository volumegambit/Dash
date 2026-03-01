import { existsSync } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EncryptedSecretStore } from './encrypted-secrets.js';

describe('EncryptedSecretStore', () => {
  let tempDir: string;
  let store: EncryptedSecretStore;
  const password = 'test-password-123';

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'mc-enc-secrets-'));
    store = new EncryptedSecretStore(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  describe('setup', () => {
    it('creates secrets.enc on first setup', async () => {
      await store.setup(password);
      expect(existsSync(join(tempDir, 'secrets.enc'))).toBe(true);
    });

    it('returns a 32-byte derived key', async () => {
      const key = await store.setup(password);
      expect(key).toBeInstanceOf(Buffer);
      expect(key.length).toBe(32);
    });

    it('unlocks the store after setup', async () => {
      expect(store.isUnlocked()).toBe(false);
      await store.setup(password);
      expect(store.isUnlocked()).toBe(true);
    });

    it('needsSetup returns true before setup', async () => {
      expect(await store.needsSetup()).toBe(true);
    });

    it('needsSetup returns false after setup', async () => {
      await store.setup(password);
      expect(await store.needsSetup()).toBe(false);
    });
  });

  describe('migration', () => {
    it('migrates existing plaintext secrets', async () => {
      const plainPath = join(tempDir, 'secrets.json');
      await writeFile(plainPath, JSON.stringify({ 'api-key': 'sk-abc123' }));

      expect(await store.needsMigration()).toBe(true);
      await store.setup(password);

      expect(existsSync(plainPath)).toBe(false);
      expect(existsSync(join(tempDir, 'secrets.enc'))).toBe(true);

      const val = await store.get('api-key');
      expect(val).toBe('sk-abc123');
    });

    it('needsMigration returns false when no plaintext file', async () => {
      expect(await store.needsMigration()).toBe(false);
    });

    it('needsMigration returns false when secrets.enc already exists', async () => {
      await store.setup(password);
      // Even if secrets.json were recreated, enc already exists
      expect(await store.needsMigration()).toBe(false);
    });
  });

  describe('unlock / lock', () => {
    it('unlockWithPassword succeeds with correct password', async () => {
      await store.setup(password);
      store.lock();
      expect(store.isUnlocked()).toBe(false);

      const key = await store.unlockWithPassword(password);
      expect(store.isUnlocked()).toBe(true);
      expect(key.length).toBe(32);
    });

    it('unlockWithPassword throws with wrong password', async () => {
      await store.setup(password);
      store.lock();
      await expect(store.unlockWithPassword('wrong-password')).rejects.toThrow();
    });

    it('unlock with derived key works', async () => {
      const key = await store.setup(password);
      store.lock();
      store.unlock(key);
      expect(store.isUnlocked()).toBe(true);
      const keys = await store.list();
      expect(keys).toEqual([]);
    });

    it('lock clears the key', async () => {
      await store.setup(password);
      store.lock();
      expect(store.isUnlocked()).toBe(false);
    });
  });

  describe('CRUD when locked', () => {
    it('get throws when locked', async () => {
      await expect(store.get('key')).rejects.toThrow('Secret store is locked');
    });

    it('set throws when locked', async () => {
      await expect(store.set('key', 'val')).rejects.toThrow('Secret store is locked');
    });

    it('delete throws when locked', async () => {
      await expect(store.delete('key')).rejects.toThrow('Secret store is locked');
    });

    it('list throws when locked', async () => {
      await expect(store.list()).rejects.toThrow('Secret store is locked');
    });
  });

  describe('CRUD when unlocked', () => {
    beforeEach(async () => {
      await store.setup(password);
    });

    it('returns null for missing key', async () => {
      const result = await store.get('nonexistent');
      expect(result).toBeNull();
    });

    it('sets and gets a secret', async () => {
      await store.set('api-key', 'secret-value');
      const result = await store.get('api-key');
      expect(result).toBe('secret-value');
    });

    it('overwrites an existing secret', async () => {
      await store.set('key', 'old');
      await store.set('key', 'new');
      const result = await store.get('key');
      expect(result).toBe('new');
    });

    it('deletes a secret', async () => {
      await store.set('key', 'value');
      await store.delete('key');
      const result = await store.get('key');
      expect(result).toBeNull();
    });

    it('lists all keys', async () => {
      await store.set('a', '1');
      await store.set('b', '2');
      await store.set('c', '3');
      const keys = await store.list();
      expect(keys).toEqual(['a', 'b', 'c']);
    });

    it('lists empty when no secrets exist', async () => {
      const keys = await store.list();
      expect(keys).toEqual([]);
    });
  });

  describe('file permissions', () => {
    it('creates secrets.enc with 0600 permissions', async () => {
      await store.setup(password);
      const filePath = join(tempDir, 'secrets.enc');
      const stats = await stat(filePath);
      expect(stats.mode & 0o777).toBe(0o600);
    });
  });

  describe('cross-instance persistence', () => {
    it('persists across instances', async () => {
      await store.setup(password);
      await store.set('key', 'value');

      const newStore = new EncryptedSecretStore(tempDir);
      await newStore.unlockWithPassword(password);
      const result = await newStore.get('key');
      expect(result).toBe('value');
    });
  });

  describe('changePassword', () => {
    it('re-encrypts data with new password', async () => {
      await store.setup(password);
      await store.set('api-key', 'sk-abc123');

      const newPassword = 'new-password-456';
      const newKey = await store.changePassword(password, newPassword);
      expect(newKey.length).toBe(32);

      // Old password should no longer work
      store.lock();
      await expect(store.unlockWithPassword(password)).rejects.toThrow();

      // New password works
      await store.unlockWithPassword(newPassword);
      const val = await store.get('api-key');
      expect(val).toBe('sk-abc123');
    });

    it('throws with wrong current password', async () => {
      await store.setup(password);
      await expect(store.changePassword('wrong-pw!', 'new-password-456')).rejects.toThrow();
    });

    it('rejects short new password', async () => {
      await store.setup(password);
      await expect(store.changePassword(password, 'short')).rejects.toThrow(
        'Password must be at least 8 characters',
      );
    });
  });

  describe('password validation', () => {
    it('rejects passwords shorter than 8 characters', async () => {
      await expect(store.setup('short')).rejects.toThrow('Password must be at least 8 characters');
    });

    it('accepts 8-character passwords', async () => {
      const key = await store.setup('12345678');
      expect(key.length).toBe(32);
    });
  });

  describe('data integrity', () => {
    it('detects tampering of encrypted file', async () => {
      await store.setup(password);
      await store.set('key', 'value');
      store.lock();

      // Tamper with the file
      const filePath = join(tempDir, 'secrets.enc');
      const raw = await readFile(filePath, 'utf-8');
      const payload = JSON.parse(raw);
      payload.ciphertext = `AAAA${payload.ciphertext.slice(4)}`;
      await writeFile(filePath, JSON.stringify(payload));

      await expect(store.unlockWithPassword(password)).rejects.toThrow();
    });
  });
});
