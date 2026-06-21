import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginConfigStore } from './config-store.js';

describe('PluginConfigStore', () => {
  let dataDir: string;
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'plugin-cfg-'));
  });
  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('returns {} when the file is missing', async () => {
    const store = new PluginConfigStore(dataDir);
    expect(await store.load()).toEqual({});
  });

  it('returns {} when the file is corrupt', async () => {
    await mkdir(join(dataDir, 'plugins'), { recursive: true });
    await writeFile(join(dataDir, 'plugins', 'config.json'), '{ broken');
    const store = new PluginConfigStore(dataDir);
    expect(await store.load()).toEqual({});
  });

  it('parses entries with enabled/trusted/path', async () => {
    await mkdir(join(dataDir, 'plugins'), { recursive: true });
    await writeFile(
      join(dataDir, 'plugins', 'config.json'),
      JSON.stringify({ disco: { enabled: true, trusted: true, path: './dev/disco' } }),
    );
    const store = new PluginConfigStore(dataDir);
    expect(await store.load()).toEqual({
      disco: { enabled: true, trusted: true, config: undefined, path: './dev/disco' },
    });
  });

  it('persists enable/trust atomically and round-trips', async () => {
    const store = new PluginConfigStore(dataDir);
    await store.setEnabled('disco', true);
    await store.setTrusted('disco', true);
    const onDisk = JSON.parse(await readFile(join(dataDir, 'plugins', 'config.json'), 'utf8'));
    expect(onDisk.disco.enabled).toBe(true);
    expect(onDisk.disco.trusted).toBe(true);
  });

  it('does not coerce truthy strings into enabled/trusted', async () => {
    await mkdir(join(dataDir, 'plugins'), { recursive: true });
    await writeFile(
      join(dataDir, 'plugins', 'config.json'),
      JSON.stringify({ p: { enabled: 'true', trusted: 'true' } }),
    );
    const store = new PluginConfigStore(dataDir);
    const loaded = await store.load();
    expect(loaded.p.enabled).toBe(false);
    expect(loaded.p.trusted).toBeUndefined();
  });

  it('does not coerce truthy numbers into enabled/trusted', async () => {
    await mkdir(join(dataDir, 'plugins'), { recursive: true });
    await writeFile(
      join(dataDir, 'plugins', 'config.json'),
      JSON.stringify({ q: { enabled: 1, trusted: 1 } }),
    );
    const store = new PluginConfigStore(dataDir);
    const loaded = await store.load();
    expect(loaded.q.enabled).toBe(false);
    expect(loaded.q.trusted).toBeUndefined();
  });

  it('ignores prototype-pollution keys without granting trust or polluting globals', async () => {
    await mkdir(join(dataDir, 'plugins'), { recursive: true });
    // Raw JSON with __proto__ / constructor own-keys (JSON.stringify would drop __proto__).
    await writeFile(
      join(dataDir, 'plugins', 'config.json'),
      '{"__proto__": {"enabled": true, "trusted": true}, "constructor": {"enabled": true}}',
    );
    const store = new PluginConfigStore(dataDir);
    const loaded = await store.load();

    // No global pollution.
    expect(({} as Record<string, unknown>).enabled).toBeUndefined();
    expect((Object.prototype as Record<string, unknown>).enabled).toBeUndefined();

    // The returned map must not have been reparented to inherit enabled/trusted.
    expect((loaded as Record<string, unknown>).enabled).toBeUndefined();
    expect((loaded as Record<string, unknown>).trusted).toBeUndefined();

    // No usable entry that would grant trust.
    expect(loaded.somePlugin).toBeUndefined();
    expect(Object.keys(loaded)).not.toContain('__proto__');
    expect(Object.keys(loaded)).not.toContain('constructor');
  });

  it('preserves trusted and path when toggling enabled', async () => {
    const store = new PluginConfigStore(dataDir);
    await mkdir(join(dataDir, 'plugins'), { recursive: true });
    await writeFile(
      join(dataDir, 'plugins', 'config.json'),
      JSON.stringify({ disco: { enabled: true, trusted: true, path: './x' } }),
    );
    await store.setEnabled('disco', false);
    const loaded = await store.load();
    expect(loaded.disco.enabled).toBe(false);
    expect(loaded.disco.trusted).toBe(true);
    expect(loaded.disco.path).toBe('./x');
  });

  it('preserves enabled when toggling trusted', async () => {
    const store = new PluginConfigStore(dataDir);
    await store.setEnabled('disco', true);
    await store.setTrusted('disco', true);
    const loaded = await store.load();
    expect(loaded.disco.enabled).toBe(true);
    expect(loaded.disco.trusted).toBe(true);
  });

  it('removes a named entry, leaving others intact', async () => {
    const store = new PluginConfigStore(dataDir);
    await store.setEnabled('disco', true);
    await store.setEnabled('keep', true);
    await store.remove('disco');
    const loaded = await store.load();
    expect(loaded.disco).toBeUndefined();
    expect(loaded.keep.enabled).toBe(true);
    // Persisted atomically — the on-disk file no longer contains the entry.
    const onDisk = JSON.parse(await readFile(join(dataDir, 'plugins', 'config.json'), 'utf8'));
    expect(onDisk.disco).toBeUndefined();
    expect(onDisk.keep.enabled).toBe(true);
  });

  it('remove is a no-op for an absent entry', async () => {
    const store = new PluginConfigStore(dataDir);
    await store.setEnabled('keep', true);
    await store.remove('nope');
    const loaded = await store.load();
    expect(loaded.keep.enabled).toBe(true);
    expect(loaded.nope).toBeUndefined();
  });
});
