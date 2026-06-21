import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverSkills, loadFlatSkills } from '@dash/agent';
import { MANIFEST_DIR, MANIFEST_FILENAME, loadPlugins } from '@dash/plugins';

describe('gateway plugin → skill wiring', () => {
  let dataDir: string;
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'gw-plugins-'));
  });
  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('a loaded plugin skill is discoverable via config.skills.paths', async () => {
    const pluginsDir = join(dataDir, 'plugins');
    const dir = join(pluginsDir, 'disco');
    await mkdir(join(dir, MANIFEST_DIR), { recursive: true });
    await writeFile(join(dir, MANIFEST_DIR, MANIFEST_FILENAME), JSON.stringify({ name: 'disco' }));
    await mkdir(join(dir, 'skills', 'greeter'), { recursive: true });
    await writeFile(
      join(dir, 'skills', 'greeter', 'SKILL.md'),
      '---\nname: greeter\ndescription: greets people\n---\nSay hi.',
    );

    const loaded = await loadPlugins({ pluginsDir, entries: { disco: { enabled: true } } });

    // Mirror the gateway merge: plugin skill dirs appended to agent skills.paths.
    const skills = await discoverSkills({ paths: loaded.skillDirs, includeBundled: false });
    expect(skills.map((s) => s.name)).toContain('greeter');
  });

  it("a plugin bar's commands/foo.md is discoverable as flat skill bar:foo", async () => {
    const pluginsDir = join(dataDir, 'plugins');
    const dir = join(pluginsDir, 'bar');
    await mkdir(join(dir, MANIFEST_DIR), { recursive: true });
    await writeFile(join(dir, MANIFEST_DIR, MANIFEST_FILENAME), JSON.stringify({ name: 'bar' }));
    await mkdir(join(dir, 'commands'), { recursive: true });
    await writeFile(join(dir, 'commands', 'foo.md'), '# Foo\nDo the foo.');

    const loaded = await loadPlugins({ pluginsDir, entries: { bar: { enabled: true } } });

    // Mirror the gateway: plugin command files become flat agent skills,
    // namespaced as <plugin>:<command> so `/bar:foo` is an exact match.
    const flat = await loadFlatSkills(
      loaded.commandFiles.map(({ pluginName, file }) => ({ file, namespace: pluginName })),
    );
    expect(flat.map((s) => s.name)).toContain('bar:foo');
  });

  it('an enabled-but-untrusted plugin contributes no mcpConfigs or binDirs', async () => {
    const pluginsDir = join(dataDir, 'plugins');
    const dir = join(pluginsDir, 'risky');
    await mkdir(join(dir, MANIFEST_DIR), { recursive: true });
    await writeFile(join(dir, MANIFEST_DIR, MANIFEST_FILENAME), JSON.stringify({ name: 'risky' }));
    await writeFile(
      join(dir, '.mcp.json'),
      JSON.stringify({ mcpServers: { db: { command: 'node', args: ['server.js'] } } }),
    );
    await mkdir(join(dir, 'bin'), { recursive: true });
    await writeFile(join(dir, 'bin', 'tool'), '#!/bin/sh\necho hi\n');

    // enabled but NOT trusted: code-execution components must be withheld.
    const loaded = await loadPlugins({ pluginsDir, entries: { risky: { enabled: true } } });

    expect(loaded.mcpConfigs).toEqual([]);
    expect(loaded.binDirs).toEqual([]);
  });
});
