import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { BUILTIN_PLUGINS, getBuiltinPluginsDir } from './index.js';

describe('builtin plugins layout', () => {
  it('resolves the plugins root', () => {
    expect(existsSync(getBuiltinPluginsDir())).toBe(true);
  });

  it('ships exactly the five suite plugins', () => {
    const dirs = readdirSync(getBuiltinPluginsDir()).sort();
    expect(dirs).toEqual([...BUILTIN_PLUGINS].sort());
  });

  it.each([...BUILTIN_PLUGINS])('%s has a valid plugin layout', (name) => {
    const root = join(getBuiltinPluginsDir(), name);
    const manifest = JSON.parse(
      readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8'),
    ) as { name: string; description?: string };
    expect(manifest.name).toBe(name);
    expect(manifest.description).toBeTruthy();
    const skillDirs = readdirSync(join(root, 'skills'));
    expect(skillDirs.length).toBeGreaterThan(0);
    for (const s of skillDirs) {
      expect(existsSync(join(root, 'skills', s, 'SKILL.md'))).toBe(true);
    }
  });
});
