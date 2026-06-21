import { symlinkSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPlugins } from './loader.js';
import { MANIFEST_DIR, MANIFEST_FILENAME } from './manifest.js';

async function writePlugin(
  root: string,
  name: string,
  opts: {
    skill?: string;
    manifest?: Record<string, unknown> | false;
    command?: string;
    bin?: boolean;
    mcp?: Record<string, unknown>;
  } = {},
): Promise<string> {
  const dir = join(root, name);
  if (opts.manifest !== false) {
    await mkdir(join(dir, MANIFEST_DIR), { recursive: true });
    await writeFile(
      join(dir, MANIFEST_DIR, MANIFEST_FILENAME),
      JSON.stringify(opts.manifest ?? { name }),
    );
  } else {
    await mkdir(dir, { recursive: true });
  }
  if (opts.skill) {
    await mkdir(join(dir, 'skills', opts.skill), { recursive: true });
    await writeFile(
      join(dir, 'skills', opts.skill, 'SKILL.md'),
      `---\nname: ${opts.skill}\ndescription: test skill\n---\nbody`,
    );
  }
  if (opts.command) {
    await mkdir(join(dir, 'commands'), { recursive: true });
    await writeFile(join(dir, 'commands', `${opts.command}.md`), `# ${opts.command}\nbody`);
  }
  if (opts.bin) {
    await mkdir(join(dir, 'bin'), { recursive: true });
    await writeFile(join(dir, 'bin', 'tool'), '#!/bin/sh\necho hi');
  }
  if (opts.mcp) {
    await writeFile(join(dir, '.mcp.json'), JSON.stringify(opts.mcp));
  }
  return dir;
}

describe('loadPlugins', () => {
  let dataDir: string;
  let pluginsDir: string;
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'loader-'));
    pluginsDir = join(dataDir, 'plugins');
    await mkdir(pluginsDir, { recursive: true });
  });
  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('loads an enabled plugin and collects its skill dir', async () => {
    const dir = await writePlugin(pluginsDir, 'disco', { skill: 'greet' });
    const loaded = await loadPlugins({
      pluginsDir,
      entries: { disco: { enabled: true } },
    });
    expect(loaded.records).toHaveLength(1);
    expect(loaded.records[0]).toMatchObject({
      name: 'disco',
      status: 'loaded',
      activated: ['skills'],
    });
    expect(loaded.skillDirs).toEqual([join(dir, 'skills')]);
  });

  it('marks a discovered-but-not-enabled plugin disabled (inert)', async () => {
    await writePlugin(pluginsDir, 'disco', { skill: 'greet' });
    const loaded = await loadPlugins({ pluginsDir, entries: {} });
    expect(loaded.records[0]).toMatchObject({ name: 'disco', status: 'disabled' });
    expect(loaded.skillDirs).toEqual([]);
  });

  it('auto-enables a path: entry (explicit dev intent)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devplug-'));
    const dir = await writePlugin(root, 'devkit', { skill: 'x' });
    const loaded = await loadPlugins({
      pluginsDir,
      entries: { devkit: { enabled: false, path: dir } },
    });
    expect(loaded.records[0]).toMatchObject({ name: 'devkit', status: 'loaded' });
    expect(loaded.skillDirs).toEqual([join(dir, 'skills')]);
    await rm(root, { recursive: true, force: true });
  });

  it('isolates a failing plugin and still loads the good one', async () => {
    await writePlugin(pluginsDir, 'good', { skill: 'g' });
    // bad: invalid JSON manifest
    const badDir = join(pluginsDir, 'bad');
    await mkdir(join(badDir, MANIFEST_DIR), { recursive: true });
    await writeFile(join(badDir, MANIFEST_DIR, MANIFEST_FILENAME), '{ broken');
    const loaded = await loadPlugins({
      pluginsDir,
      entries: { good: { enabled: true }, bad: { enabled: true } },
    });
    const byName = Object.fromEntries(loaded.records.map((r) => [r.name, r]));
    expect(byName.good.status).toBe('loaded');
    expect(byName.bad.status).toBe('error');
    expect(byName.bad.failure?.phase).toBe('manifest');
  });

  it('returns [] records when pluginsDir does not exist and no path entries', async () => {
    const loaded = await loadPlugins({ pluginsDir: join(dataDir, 'nope'), entries: {} });
    expect(loaded.records).toEqual([]);
    expect(loaded.skillDirs).toEqual([]);
  });

  it('does not throw when pluginsDir read fails and still loads path entries', async () => {
    // pluginsDir is a symlink to a regular file: existsSync() is true, but
    // readdirSync() throws ENOTDIR. This must not escape loadPlugins.
    const file = join(dataDir, 'not-a-dir');
    await writeFile(file, 'regular file');
    const brokenPluginsDir = join(dataDir, 'plugins-link');
    symlinkSync(file, brokenPluginsDir);
    const root = await mkdtemp(join(tmpdir(), 'devplug-'));
    const dir = await writePlugin(root, 'devkit', { skill: 'x' });
    const warnings: string[] = [];
    const loaded = await loadPlugins({
      pluginsDir: brokenPluginsDir,
      entries: { devkit: { enabled: false, path: dir } },
      logger: { info() {}, warn: (m) => warnings.push(m) },
    });
    expect(loaded.records).toHaveLength(1);
    expect(loaded.records[0]).toMatchObject({ name: 'devkit', status: 'loaded' });
    expect(loaded.skillDirs).toEqual([join(dir, 'skills')]);
    expect(warnings.some((w) => w.includes('plugins'))).toBe(true);
    await rm(root, { recursive: true, force: true });
  });

  it('dedupes a name present as both a path entry and a pluginsDir subdir (path wins)', async () => {
    // Same plugin name under pluginsDir AND as an explicit path entry.
    await writePlugin(pluginsDir, 'dup', { skill: 'fromdir' });
    const root = await mkdtemp(join(tmpdir(), 'devplug-'));
    const pathDir = await writePlugin(root, 'dup', { skill: 'frompath' });
    const loaded = await loadPlugins({
      pluginsDir,
      entries: { dup: { enabled: true, path: pathDir } },
    });
    expect(loaded.records).toHaveLength(1);
    expect(loaded.records[0]).toMatchObject({ name: 'dup', status: 'loaded', dir: pathDir });
    expect(loaded.skillDirs).toEqual([join(pathDir, 'skills')]);
    await rm(root, { recursive: true, force: true });
  });

  it('flattens skillDirs in discovery order (path entry first, then pluginsDir)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devplug-'));
    const pathDir = await writePlugin(root, 'viapath', { skill: 'p' });
    const dirDir = await writePlugin(pluginsDir, 'viadir', { skill: 'd' });
    const loaded = await loadPlugins({
      pluginsDir,
      entries: { viapath: { enabled: true, path: pathDir }, viadir: { enabled: true } },
    });
    expect(loaded.skillDirs).toEqual([join(pathDir, 'skills'), join(dirDir, 'skills')]);
    await rm(root, { recursive: true, force: true });
  });

  it('collects commands for an enabled plugin (markdown — no trust needed)', async () => {
    const dir = await writePlugin(pluginsDir, 'p', { skill: 'g', command: 'deploy' });
    const loaded = await loadPlugins({ pluginsDir, entries: { p: { enabled: true } } });
    expect(loaded.commandFiles).toEqual([
      { pluginName: 'p', file: join(dir, 'commands', 'deploy.md') },
    ]);
    expect(loaded.records[0].activated).toEqual(expect.arrayContaining(['skills', 'commands']));
  });

  it('withholds mcp + bin from an enabled-but-untrusted plugin', async () => {
    await writePlugin(pluginsDir, 'p', {
      mcp: { mcpServers: { db: { command: 'node' } } },
      bin: true,
    });
    const loaded = await loadPlugins({ pluginsDir, entries: { p: { enabled: true } } });
    expect(loaded.mcpConfigs).toEqual([]);
    expect(loaded.binDirs).toEqual([]);
    expect(loaded.records[0].noop).toEqual(expect.arrayContaining(['mcp', 'bin']));
  });

  it('activates mcp + bin for an enabled+trusted plugin', async () => {
    const dir = await writePlugin(pluginsDir, 'p', {
      mcp: { mcpServers: { db: { command: 'node' } } },
      bin: true,
    });
    const loaded = await loadPlugins({
      pluginsDir,
      entries: { p: { enabled: true, trusted: true } },
    });
    expect(loaded.mcpConfigs).toEqual([
      { pluginName: 'p', config: { name: 'p-db', transport: { type: 'stdio', command: 'node' } } },
    ]);
    expect(loaded.binDirs).toEqual([join(dir, 'bin')]);
    expect(loaded.records[0].activated).toEqual(expect.arrayContaining(['mcp', 'bin']));
  });

  it('records an mcp translation failure without aborting (status error, others load)', async () => {
    await writePlugin(pluginsDir, 'bad', {
      mcp: { mcpServers: { s: { type: 'ws', url: 'wss://x' } } },
    });
    await writePlugin(pluginsDir, 'good', { skill: 'g' });
    const loaded = await loadPlugins({
      pluginsDir,
      entries: { bad: { enabled: true, trusted: true }, good: { enabled: true } },
    });
    const byName = Object.fromEntries(loaded.records.map((r) => [r.name, r]));
    expect(byName.good.status).toBe('loaded');
    expect(byName.bad.status).toBe('error');
    expect(byName.bad.failure?.phase).toBe('route');
  });

  it('does not leak a failing trusted plugin components into the aggregates', async () => {
    // Trusted plugin with valid skills/, commands/, bin/, BUT a malformed
    // .mcp.json that translate rejects. Its components must NOT survive in the
    // returned aggregates — per-plugin activation is atomic.
    const badDir = await writePlugin(pluginsDir, 'bad', {
      skill: 'bskill',
      command: 'bcmd',
      bin: true,
      mcp: { mcpServers: { s: { type: 'ws', url: 'wss://x' } } },
    });
    const goodDir = await writePlugin(pluginsDir, 'good', {
      skill: 'gskill',
      command: 'gcmd',
      bin: true,
      mcp: { mcpServers: { db: { command: 'node' } } },
    });
    const loaded = await loadPlugins({
      pluginsDir,
      entries: {
        bad: { enabled: true, trusted: true },
        good: { enabled: true, trusted: true },
      },
    });
    const byName = Object.fromEntries(loaded.records.map((r) => [r.name, r]));
    expect(byName.bad.status).toBe('error');
    expect(byName.good.status).toBe('loaded');

    // Nothing from `bad` leaked into the aggregates.
    expect(loaded.skillDirs).not.toContain(join(badDir, 'skills'));
    expect(loaded.commandFiles.some((c) => c.file === join(badDir, 'commands', 'bcmd.md'))).toBe(
      false,
    );
    expect(loaded.binDirs).not.toContain(join(badDir, 'bin'));
    expect(loaded.mcpConfigs.some((c) => c.pluginName === 'bad')).toBe(false);

    // `good` is fully present in the aggregates.
    expect(loaded.skillDirs).toContain(join(goodDir, 'skills'));
    expect(loaded.commandFiles.some((c) => c.file === join(goodDir, 'commands', 'gcmd.md'))).toBe(
      true,
    );
    expect(loaded.binDirs).toContain(join(goodDir, 'bin'));
    expect(loaded.mcpConfigs.some((c) => c.pluginName === 'good')).toBe(true);
  });
});
