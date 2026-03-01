import { stat } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileSecretStore } from './secrets.js';

describe('FileSecretStore', () => {
  let tempDir: string;
  let store: FileSecretStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'mc-secrets-'));
    store = new FileSecretStore(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
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

  it('creates file with 0600 permissions', async () => {
    await store.set('key', 'value');
    const filePath = join(tempDir, 'secrets.json');
    const stats = await stat(filePath);
    // 0o600 = owner read/write only
    expect(stats.mode & 0o777).toBe(0o600);
  });

  it('persists across instances', async () => {
    await store.set('key', 'value');
    const newStore = new FileSecretStore(tempDir);
    const result = await newStore.get('key');
    expect(result).toBe('value');
  });
});
