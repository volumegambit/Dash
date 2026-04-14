import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GatewayCredentialStore } from './credential-store.js';

let dataDir: string;
let store: GatewayCredentialStore;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'gateway-cred-store-'));
  store = new GatewayCredentialStore(dataDir);
  await store.init();
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe('GatewayCredentialStore', () => {
  it('generates secret.key on first init', async () => {
    const keyPath = join(dataDir, 'secret.key');
    const raw = await readFile(keyPath, 'utf-8');
    const parsed = JSON.parse(raw) as { key: string; salt: string };
    expect(parsed.key).toBeTruthy();
    expect(parsed.salt).toBeTruthy();
    // Key should be a 32-byte buffer encoded as base64
    const keyBuf = Buffer.from(parsed.key, 'base64');
    expect(keyBuf.length).toBe(32);
  });

  it('has 0600 permissions on secret.key', async () => {
    const keyPath = join(dataDir, 'secret.key');
    const info = await stat(keyPath);
    const mode = info.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('reuses existing secret.key on subsequent init (data survives)', async () => {
    await store.set('api-key', 'my-secret-value');

    // Create a new store instance pointing at the same directory
    const store2 = new GatewayCredentialStore(dataDir);
    await store2.init();

    const value = await store2.get('api-key');
    expect(value).toBe('my-secret-value');
  });

  it('set and get a credential', async () => {
    await store.set('telegram-token', 'bot123456:ABC-DEF');
    const value = await store.get('telegram-token');
    expect(value).toBe('bot123456:ABC-DEF');
  });

  it('list returns keys without values', async () => {
    await store.set('key-a', 'value-a');
    await store.set('key-b', 'value-b');
    const keys = await store.list();
    expect(keys).toContain('key-a');
    expect(keys).toContain('key-b');
    expect(keys).toHaveLength(2);
    // list should not contain values
    expect(keys).not.toContain('value-a');
    expect(keys).not.toContain('value-b');
  });

  it('delete removes a credential', async () => {
    await store.set('temp-key', 'temp-value');
    await store.delete('temp-key');
    const value = await store.get('temp-key');
    expect(value).toBeNull();
    const keys = await store.list();
    expect(keys).not.toContain('temp-key');
  });

  it('get returns null for missing key', async () => {
    const value = await store.get('nonexistent-key');
    expect(value).toBeNull();
  });

  it('data file is encrypted (has iv/ciphertext fields, not plaintext keys)', async () => {
    await store.set('my-api-key', 'super-secret-value');

    const encPath = join(dataDir, 'credentials.enc');
    const raw = await readFile(encPath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    // Should have encrypted payload fields
    expect(parsed).toHaveProperty('version', 1);
    expect(parsed).toHaveProperty('iv');
    expect(parsed).toHaveProperty('ciphertext');
    expect(parsed).toHaveProperty('tag');
    expect(parsed).toHaveProperty('salt');

    // Should NOT contain plaintext key or value
    expect(raw).not.toContain('my-api-key');
    expect(raw).not.toContain('super-secret-value');
  });

  it('has 0600 permissions on credentials.enc', async () => {
    await store.set('key', 'value');
    const encPath = join(dataDir, 'credentials.enc');
    const info = await stat(encPath);
    const mode = info.mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
