import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from '@dash/logging';
import { PluginConfigStore } from '@dash/plugins';
import { ensureCoreProvidersPlugin } from './bundled-plugin.js';

const NOOP_LOGGER: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** Build a throwaway bundled plugin source dir with a given manifest version. */
async function makeBundle(root: string, version: string): Promise<string> {
  const dir = join(root, 'bundled', 'dash-core-providers');
  await mkdir(join(dir, '.claude-plugin'), { recursive: true });
  await mkdir(join(dir, 'providers'), { recursive: true });
  await writeFile(
    join(dir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'dash-core-providers', version, description: 'Anthropic and friends' }),
  );
  await writeFile(
    join(dir, 'providers', 'anthropic.json'),
    JSON.stringify({ id: 'anthropic', label: 'Anthropic' }),
  );
  return dir;
}

async function exists(path: string): Promise<boolean> {
  return stat(path)
    .then(() => true)
    .catch(() => false);
}

describe('ensureCoreProvidersPlugin', () => {
  let root: string;
  let dataDir: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'bundled-plugin-'));
    dataDir = join(root, 'data');
    await mkdir(dataDir, { recursive: true });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const installedDir = () => join(dataDir, 'plugins', 'dash-core-providers');

  it('fresh install copies files and writes the config entry', async () => {
    const bundledDir = await makeBundle(root, '0.2.0');
    const configStore = new PluginConfigStore(dataDir);
    await ensureCoreProvidersPlugin({ dataDir, bundledDir, configStore, logger: NOOP_LOGGER });

    expect(await exists(join(installedDir(), '.claude-plugin', 'plugin.json'))).toBe(true);
    expect(await exists(join(installedDir(), 'providers', 'anthropic.json'))).toBe(true);
    const entry = (await configStore.load())['dash-core-providers'];
    expect(entry).toEqual({
      enabled: true,
      trusted: true,
      installed: true,
      source: 'bundled://0.2.0',
      config: undefined,
      path: undefined,
    });
  });

  it('is a no-op copy on a second run with the same version (sentinel survives)', async () => {
    const bundledDir = await makeBundle(root, '0.2.0');
    const configStore = new PluginConfigStore(dataDir);
    await ensureCoreProvidersPlugin({ dataDir, bundledDir, configStore, logger: NOOP_LOGGER });

    // Drop a sentinel into the installed copy; a re-copy would wipe it.
    const sentinel = join(installedDir(), 'SENTINEL');
    await writeFile(sentinel, 'keep');
    await ensureCoreProvidersPlugin({ dataDir, bundledDir, configStore, logger: NOOP_LOGGER });
    expect(await exists(sentinel)).toBe(true);
  });

  it('re-trusts and re-enables even when up-to-date (user cannot untrust core)', async () => {
    const bundledDir = await makeBundle(root, '0.2.0');
    const configStore = new PluginConfigStore(dataDir);
    await ensureCoreProvidersPlugin({ dataDir, bundledDir, configStore, logger: NOOP_LOGGER });

    await configStore.setTrusted('dash-core-providers', false);
    await configStore.setEnabled('dash-core-providers', false);
    await ensureCoreProvidersPlugin({ dataDir, bundledDir, configStore, logger: NOOP_LOGGER });

    const entry = (await configStore.load())['dash-core-providers'];
    expect(entry?.trusted).toBe(true);
    expect(entry?.enabled).toBe(true);
  });

  it('re-copies and updates source on a version bump (sentinel gone)', async () => {
    const bundledDir = await makeBundle(root, '0.2.0');
    const configStore = new PluginConfigStore(dataDir);
    await ensureCoreProvidersPlugin({ dataDir, bundledDir, configStore, logger: NOOP_LOGGER });

    const sentinel = join(installedDir(), 'SENTINEL');
    await writeFile(sentinel, 'keep');

    await makeBundle(root, '0.3.0'); // bump the bundled manifest version
    await ensureCoreProvidersPlugin({ dataDir, bundledDir, configStore, logger: NOOP_LOGGER });

    expect(await exists(sentinel)).toBe(false);
    const entry = (await configStore.load())['dash-core-providers'];
    expect(entry?.source).toBe('bundled://0.3.0');
  });

  it('re-copies when the installed manifest is corrupted', async () => {
    const bundledDir = await makeBundle(root, '0.2.0');
    const configStore = new PluginConfigStore(dataDir);
    await ensureCoreProvidersPlugin({ dataDir, bundledDir, configStore, logger: NOOP_LOGGER });

    const sentinel = join(installedDir(), 'SENTINEL');
    await writeFile(sentinel, 'keep');
    await writeFile(join(installedDir(), '.claude-plugin', 'plugin.json'), '{ not json');

    await ensureCoreProvidersPlugin({ dataDir, bundledDir, configStore, logger: NOOP_LOGGER });
    expect(await exists(sentinel)).toBe(false);
    expect(await exists(join(installedDir(), 'providers', 'anthropic.json'))).toBe(true);
  });

  it('throws when the bundled dir is missing', async () => {
    const configStore = new PluginConfigStore(dataDir);
    await expect(
      ensureCoreProvidersPlugin({
        dataDir,
        bundledDir: join(root, 'does-not-exist'),
        configStore,
        logger: NOOP_LOGGER,
      }),
    ).rejects.toThrow();
  });
});
