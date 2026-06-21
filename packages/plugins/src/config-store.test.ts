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
});
