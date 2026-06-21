import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverSkills } from '@dash/agent';
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
});
