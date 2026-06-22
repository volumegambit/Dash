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

  // T-b (F2): concurrent setEnabled('a') + setTrusted('b') both survive. Without
  // a write queue, each setter does load→mutate→save against a stale snapshot, so
  // the second save clobbers the first key (read-modify-write race; atomic rename
  // prevents corruption, not lost updates).
  it('serializes concurrent writes so neither update is lost', async () => {
    const store = new PluginConfigStore(dataDir);
    await Promise.all([store.setEnabled('a', true), store.setTrusted('b', true)]);
    const loaded = await store.load();
    expect(loaded.a?.enabled).toBe(true);
    expect(loaded.b?.trusted).toBe(true);
  });

  it('serializes a burst of concurrent writes without dropping any entry', async () => {
    const store = new PluginConfigStore(dataDir);
    const names = Array.from({ length: 20 }, (_, i) => `p${i}`);
    await Promise.all(names.map((n) => store.setEnabled(n, true)));
    const loaded = await store.load();
    for (const n of names) expect(loaded[n]?.enabled).toBe(true);
  });

  // F10: the setters/remove must reject the prototype-pollution keys the same way
  // load() does, so a crafted name can never reparent the on-disk map or pollute
  // globals (defense-in-depth — not currently route-reachable).
  it('setEnabled ignores prototype-pollution keys', async () => {
    const store = new PluginConfigStore(dataDir);
    await store.setEnabled('__proto__', true);
    await store.setEnabled('constructor', true);
    await store.setEnabled('prototype', true);
    expect(({} as Record<string, unknown>).enabled).toBeUndefined();
    expect((Object.prototype as Record<string, unknown>).enabled).toBeUndefined();
    const loaded = await store.load();
    expect(Object.keys(loaded)).not.toContain('__proto__');
    expect(Object.keys(loaded)).not.toContain('constructor');
    expect(Object.keys(loaded)).not.toContain('prototype');
  });

  it('setTrusted and remove ignore prototype-pollution keys', async () => {
    const store = new PluginConfigStore(dataDir);
    await store.setTrusted('__proto__', true);
    await store.remove('constructor');
    expect((Object.prototype as Record<string, unknown>).trusted).toBeUndefined();
    const loaded = await store.load();
    expect(Object.keys(loaded)).not.toContain('__proto__');
  });

  // --- setSource / setInstalled (P2 install provenance) ---

  it('persists source and round-trips via a fresh store', async () => {
    const store = new PluginConfigStore(dataDir);
    await store.setSource('disco', 'git:owner/repo@main');
    // A fresh store reads the same on-disk file.
    const fresh = new PluginConfigStore(dataDir);
    const loaded = await fresh.load();
    expect(loaded.disco.source).toBe('git:owner/repo@main');
  });

  it('persists installed and round-trips via a fresh store', async () => {
    const store = new PluginConfigStore(dataDir);
    await store.setInstalled('disco', true);
    const fresh = new PluginConfigStore(dataDir);
    const loaded = await fresh.load();
    expect(loaded.disco.installed).toBe(true);
  });

  it('setInstalled(false) clears the installed flag (becomes undefined on load)', async () => {
    const store = new PluginConfigStore(dataDir);
    await store.setInstalled('disco', true);
    await store.setInstalled('disco', false);
    const loaded = await store.load();
    // load() only surfaces installed when strictly true.
    expect(loaded.disco.installed).toBeUndefined();
  });

  it('preserves enabled/trusted when setting source and installed', async () => {
    const store = new PluginConfigStore(dataDir);
    await store.setEnabled('disco', true);
    await store.setTrusted('disco', true);
    await store.setSource('disco', '/abs/path');
    await store.setInstalled('disco', true);
    const loaded = await store.load();
    expect(loaded.disco.enabled).toBe(true);
    expect(loaded.disco.trusted).toBe(true);
    expect(loaded.disco.source).toBe('/abs/path');
    expect(loaded.disco.installed).toBe(true);
  });

  it('setSource and setInstalled ignore prototype-pollution keys', async () => {
    const store = new PluginConfigStore(dataDir);
    await store.setSource('__proto__', 'x');
    await store.setInstalled('constructor', true);
    await store.setInstalled('prototype', true);
    expect(({} as Record<string, unknown>).source).toBeUndefined();
    expect(({} as Record<string, unknown>).installed).toBeUndefined();
    expect((Object.prototype as Record<string, unknown>).source).toBeUndefined();
    const loaded = await store.load();
    expect(Object.keys(loaded)).not.toContain('__proto__');
    expect(Object.keys(loaded)).not.toContain('constructor');
    expect(Object.keys(loaded)).not.toContain('prototype');
  });
});
