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
    agent?: string;
    bin?: boolean;
    mcp?: Record<string, unknown>;
    hooks?: Record<string, unknown> | string;
    /** Map of `<name>` → catalog object (or raw string for malformed cases). */
    providers?: Record<string, Record<string, unknown> | string>;
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
  if (opts.agent) {
    await mkdir(join(dir, 'agents'), { recursive: true });
    await writeFile(join(dir, 'agents', `${opts.agent}.md`), `# ${opts.agent}\nbody`);
  }
  if (opts.bin) {
    await mkdir(join(dir, 'bin'), { recursive: true });
    await writeFile(join(dir, 'bin', 'tool'), '#!/bin/sh\necho hi');
  }
  if (opts.mcp) {
    await writeFile(join(dir, '.mcp.json'), JSON.stringify(opts.mcp));
  }
  if (opts.hooks !== undefined) {
    await mkdir(join(dir, 'hooks'), { recursive: true });
    await writeFile(
      join(dir, 'hooks', 'hooks.json'),
      typeof opts.hooks === 'string' ? opts.hooks : JSON.stringify(opts.hooks),
    );
  }
  if (opts.providers) {
    await mkdir(join(dir, 'providers'), { recursive: true });
    for (const [name, body] of Object.entries(opts.providers)) {
      await writeFile(
        join(dir, 'providers', `${name}.json`),
        typeof body === 'string' ? body : JSON.stringify(body),
      );
    }
  }
  return dir;
}

/** A minimal valid provider catalog body keyed by id. */
function catalog(id: string): Record<string, unknown> {
  return {
    id,
    label: id,
    credentialPrefix: `${id}-api-key`,
    baseUrl: `https://api.${id}.test`,
    api: 'openai-completions',
    models: [{ id: `${id}-large`, contextWindow: 1000, maxTokens: 100 }],
  };
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

  // F5: the loader record must carry the manifest's displayName (distinct from
  // description) so the gateway status record can title pickers/cards with it.
  it('carries manifest displayName through loaded + disabled records', async () => {
    await writePlugin(pluginsDir, 'disco', {
      manifest: { name: 'disco', displayName: 'Disco Ball', description: 'A disco plugin' },
      skill: 'greet',
    });
    const loadedOn = await loadPlugins({ pluginsDir, entries: { disco: { enabled: true } } });
    expect(loadedOn.records[0].displayName).toBe('Disco Ball');
    expect(loadedOn.records[0].description).toBe('A disco plugin');

    const loadedOff = await loadPlugins({ pluginsDir, entries: {} });
    expect(loadedOff.records[0].status).toBe('disabled');
    expect(loadedOff.records[0].displayName).toBe('Disco Ball');
  });

  it('leaves displayName undefined when the manifest omits it', async () => {
    await writePlugin(pluginsDir, 'plain', { manifest: { name: 'plain' }, skill: 'x' });
    const loaded = await loadPlugins({ pluginsDir, entries: { plain: { enabled: true } } });
    expect(loaded.records[0].displayName).toBeUndefined();
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

  it('collects agents for an enabled plugin (markdown — no trust needed)', async () => {
    const dir = await writePlugin(pluginsDir, 'p', { skill: 'g', agent: 'reviewer' });
    const loaded = await loadPlugins({ pluginsDir, entries: { p: { enabled: true } } });
    expect(loaded.agentFiles).toEqual([
      { pluginName: 'p', file: join(dir, 'agents', 'reviewer.md') },
    ]);
    expect(loaded.records[0].activated).toEqual(expect.arrayContaining(['skills', 'agents']));
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

  it('collects hookConfigs for an enabled+trusted plugin with valid hooks.json', async () => {
    const eventMap = {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo' }] }],
    };
    const dir = await writePlugin(pluginsDir, 'hooky', { hooks: { hooks: eventMap } });
    const loaded = await loadPlugins({
      pluginsDir,
      entries: { hooky: { enabled: true, trusted: true } },
    });
    expect(loaded.hookConfigs).toEqual([
      { pluginName: 'hooky', pluginRoot: dir, config: eventMap },
    ]);
    expect(loaded.records[0].activated).toEqual(expect.arrayContaining(['hooks']));
  });

  it('withholds hooks from an enabled-but-untrusted plugin', async () => {
    await writePlugin(pluginsDir, 'hooky', {
      hooks: {
        hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo' }] }] },
      },
    });
    const loaded = await loadPlugins({ pluginsDir, entries: { hooky: { enabled: true } } });
    expect(loaded.hookConfigs).toEqual([]);
    expect(loaded.records[0].noop).toEqual(expect.arrayContaining(['hooks']));
  });

  it('treats an empty hooks.json on a trusted plugin as present-but-inactive (noop)', async () => {
    await writePlugin(pluginsDir, 'hooky', { hooks: {} });
    const loaded = await loadPlugins({
      pluginsDir,
      entries: { hooky: { enabled: true, trusted: true } },
    });
    expect(loaded.hookConfigs).toEqual([]);
    expect(loaded.records[0].noop).toEqual(expect.arrayContaining(['hooks']));
    expect(loaded.records[0].activated).not.toContain('hooks');
  });

  it('records a malformed hooks.json failure without aborting (status error, others load)', async () => {
    await writePlugin(pluginsDir, 'bad', { hooks: '{ broken' });
    await writePlugin(pluginsDir, 'good', { skill: 'g' });
    const loaded = await loadPlugins({
      pluginsDir,
      entries: { bad: { enabled: true, trusted: true }, good: { enabled: true } },
    });
    const byName = Object.fromEntries(loaded.records.map((r) => [r.name, r]));
    expect(byName.good.status).toBe('loaded');
    expect(byName.bad.status).toBe('error');
    expect(byName.bad.failure?.phase).toBe('route');
    // Nothing from `bad` leaked into hookConfigs.
    expect(loaded.hookConfigs.some((c) => c.pluginName === 'bad')).toBe(false);
  });

  it('does not leak a failing trusted plugin hookConfigs into the aggregates', async () => {
    // Trusted plugin with valid skills/ but a malformed hooks.json. Its
    // components (including any prior to hooks) must NOT survive — atomic.
    const badDir = await writePlugin(pluginsDir, 'bad', {
      skill: 'bskill',
      hooks: '{ broken',
    });
    const goodDir = await writePlugin(pluginsDir, 'good', {
      skill: 'gskill',
      hooks: { hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'echo' }] }] } },
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
    expect(loaded.skillDirs).not.toContain(join(badDir, 'skills'));
    expect(loaded.hookConfigs.some((c) => c.pluginName === 'bad')).toBe(false);
    expect(loaded.skillDirs).toContain(join(goodDir, 'skills'));
    expect(loaded.hookConfigs.some((c) => c.pluginName === 'good')).toBe(true);
  });

  it('collects providerConfigs for an enabled+trusted plugin', async () => {
    await writePlugin(pluginsDir, 'p', { providers: { acme: catalog('acme') } });
    const loaded = await loadPlugins({
      pluginsDir,
      entries: { p: { enabled: true, trusted: true } },
    });
    expect(loaded.providerConfigs).toEqual([
      {
        pluginName: 'p',
        catalog: {
          id: 'acme',
          label: 'acme',
          credentialPrefix: 'acme-api-key',
          baseUrl: 'https://api.acme.test',
          api: 'openai-completions',
          models: [{ id: 'acme-large', contextWindow: 1000, maxTokens: 100 }],
        },
      },
    ]);
    expect(loaded.records[0].activated).toEqual(expect.arrayContaining(['providers']));
  });

  it('pushes one providerConfig entry per catalog file', async () => {
    await writePlugin(pluginsDir, 'p', {
      providers: { acme: catalog('acme'), beta: catalog('beta') },
    });
    const loaded = await loadPlugins({
      pluginsDir,
      entries: { p: { enabled: true, trusted: true } },
    });
    expect(loaded.providerConfigs.map((c) => c.catalog.id).sort()).toEqual(['acme', 'beta']);
  });

  it('withholds providers from an enabled-but-untrusted plugin', async () => {
    await writePlugin(pluginsDir, 'p', { providers: { acme: catalog('acme') } });
    const loaded = await loadPlugins({ pluginsDir, entries: { p: { enabled: true } } });
    expect(loaded.providerConfigs).toEqual([]);
    expect(loaded.records[0].noop).toEqual(expect.arrayContaining(['providers']));
  });

  it('noops providers for an untrusted plugin that DECLARES providers but has no files on disk', async () => {
    // Manifest intent without a providers/ dir or catalog files: declaring
    // `providers` is enough to record the untrusted skip as `noop: 'providers'`.
    await writePlugin(pluginsDir, 'p', { manifest: { name: 'p', providers: ['./providers'] } });
    const loaded = await loadPlugins({ pluginsDir, entries: { p: { enabled: true } } });
    expect(loaded.providerConfigs).toEqual([]);
    expect(loaded.records[0].noop).toEqual(expect.arrayContaining(['providers']));
    expect(loaded.records[0].activated).not.toContain('providers');
  });

  it('records a malformed catalog failure without aborting (status error, others load)', async () => {
    await writePlugin(pluginsDir, 'bad', { providers: { broken: { id: 'broken' } } });
    await writePlugin(pluginsDir, 'good', { skill: 'g' });
    const loaded = await loadPlugins({
      pluginsDir,
      entries: { bad: { enabled: true, trusted: true }, good: { enabled: true } },
    });
    const byName = Object.fromEntries(loaded.records.map((r) => [r.name, r]));
    expect(byName.good.status).toBe('loaded');
    expect(byName.bad.status).toBe('error');
    expect(byName.bad.failure?.phase).toBe('route');
    expect(loaded.providerConfigs.some((c) => c.pluginName === 'bad')).toBe(false);
  });

  it('does not leak a failing trusted plugin providerConfigs into the aggregates', async () => {
    // Trusted plugin with a valid skill but a malformed catalog. Its prior
    // components must NOT survive — per-plugin activation is atomic.
    const badDir = await writePlugin(pluginsDir, 'bad', {
      skill: 'bskill',
      providers: { acme: catalog('acme'), broken: '{ not json' },
    });
    const goodDir = await writePlugin(pluginsDir, 'good', {
      skill: 'gskill',
      providers: { acme: catalog('acme') },
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
    expect(loaded.skillDirs).not.toContain(join(badDir, 'skills'));
    expect(loaded.providerConfigs.some((c) => c.pluginName === 'bad')).toBe(false);
    expect(loaded.skillDirs).toContain(join(goodDir, 'skills'));
    expect(loaded.providerConfigs.some((c) => c.pluginName === 'good')).toBe(true);
  });

  it('returns providerConfigs as [] when no plugin contributes a catalog', async () => {
    await writePlugin(pluginsDir, 'p', { skill: 'g' });
    const loaded = await loadPlugins({ pluginsDir, entries: { p: { enabled: true } } });
    expect(loaded.providerConfigs).toEqual([]);
  });
});
