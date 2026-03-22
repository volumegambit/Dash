import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileTokenStore } from './file-token-store.js';

describe('FileTokenStore', () => {
  let dir: string;
  let store: FileTokenStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mcp-fts-'));
    store = new FileTokenStore(join(dir, 'tokens.json'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns undefined for missing keys', async () => {
    expect(await store.get('nonexistent')).toBeUndefined();
  });

  it('sets and gets a value', async () => {
    await store.set('key1', 'value1');
    expect(await store.get('key1')).toBe('value1');
  });

  it('overwrites existing values', async () => {
    await store.set('key1', 'old');
    await store.set('key1', 'new');
    expect(await store.get('key1')).toBe('new');
  });

  it('deletes a key', async () => {
    await store.set('key1', 'value1');
    await store.delete('key1');
    expect(await store.get('key1')).toBeUndefined();
  });

  it('persists to disk', async () => {
    await store.set('persist', 'data');
    const store2 = new FileTokenStore(join(dir, 'tokens.json'));
    expect(await store2.get('persist')).toBe('data');
  });

  it('sets file permissions to 0600', async () => {
    await store.set('key', 'val');
    const filePath = join(dir, 'tokens.json');
    const s = await stat(filePath);
    expect(s.mode & 0o777).toBe(0o600);
  });

  it('creates parent directories if needed', async () => {
    const nested = new FileTokenStore(join(dir, 'sub', 'deep', 'tokens.json'));
    await nested.set('key', 'val');
    expect(await nested.get('key')).toBe('val');
  });

  it('handles concurrent writes safely', async () => {
    await Promise.all([
      store.set('a', '1'),
      store.set('b', '2'),
      store.set('c', '3'),
    ]);
    expect(await store.get('a')).toBe('1');
    expect(await store.get('b')).toBe('2');
    expect(await store.get('c')).toBe('3');
  });
});
