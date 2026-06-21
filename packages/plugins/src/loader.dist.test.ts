import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Import the BUILT entry, not source — proves dist packaging works.
import { loadPlugins, MANIFEST_DIR, MANIFEST_FILENAME } from '../dist/index.js';

describe('@dash/plugins dist entry', () => {
  let dataDir: string;
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'loader-dist-'));
  });
  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('loadPlugins works from the built bundle', async () => {
    const pluginsDir = join(dataDir, 'plugins');
    const dir = join(pluginsDir, 'disco');
    await mkdir(join(dir, MANIFEST_DIR), { recursive: true });
    await writeFile(join(dir, MANIFEST_DIR, MANIFEST_FILENAME), JSON.stringify({ name: 'disco' }));
    await mkdir(join(dir, 'skills', 'greet'), { recursive: true });
    await writeFile(join(dir, 'skills', 'greet', 'SKILL.md'), '---\nname: greet\ndescription: x\n---\nb');

    const loaded = await loadPlugins({ pluginsDir, entries: { disco: { enabled: true } } });
    expect(loaded.records[0].status).toBe('loaded');
    expect(loaded.skillDirs).toEqual([join(dir, 'skills')]);
  });
});
