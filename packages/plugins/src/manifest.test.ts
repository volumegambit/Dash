import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  MANIFEST_DIR,
  MANIFEST_FILENAME,
  readManifest,
  resolveAgentFiles,
  resolveBinDir,
  resolveCommandFiles,
  resolveSkillDirs,
  validateManifest,
} from './manifest.js';

describe('validateManifest', () => {
  it('accepts a minimal manifest (name only) and ignores unknown fields', () => {
    const m = validateManifest({ name: 'my-plugin', futureField: 1 }, '/x/my-plugin');
    expect(m.name).toBe('my-plugin');
    expect((m as unknown as Record<string, unknown>).futureField).toBeUndefined();
  });

  it('falls back to the directory basename when name is absent', () => {
    const m = validateManifest({ description: 'x' }, '/x/dir-name');
    expect(m.name).toBe('dir-name');
  });

  it('rejects a non-kebab-case name', () => {
    expect(() => validateManifest({ name: 'MyPlugin' }, '/x/p')).toThrow(/kebab-case/);
  });

  it('rejects non-object input', () => {
    expect(() => validateManifest([], '/x/p')).toThrow(/object/);
  });

  it('normalizes string skills to an array', () => {
    const m = validateManifest({ name: 'p', skills: './extra-skills' }, '/x/p');
    expect(m.skills).toEqual(['./extra-skills']);
  });

  it('normalizes string agents to an array', () => {
    const m = validateManifest({ name: 'p', agents: './a' }, '/x/p');
    expect(m.agents).toEqual(['./a']);
  });

  it('preserves all recognized optional fields', () => {
    const m = validateManifest(
      {
        name: 'p',
        author: { name: 'A', email: 'a@x', url: 'u' },
        homepage: 'https://h',
        repository: 'https://r',
        license: 'MIT',
        keywords: ['a', 'b'],
      },
      '/x/p',
    );
    expect(m.author).toEqual({ name: 'A', email: 'a@x', url: 'u' });
    expect(m.homepage).toBe('https://h');
    expect(m.repository).toBe('https://r');
    expect(m.license).toBe('MIT');
    expect(m.keywords).toEqual(['a', 'b']);
  });

  it('drops author when its name is not a string', () => {
    const m = validateManifest({ name: 'p', author: { name: 42 } }, '/x/p');
    expect(m.author).toBeUndefined();
  });

  it('drops keywords when not an array of strings', () => {
    expect(validateManifest({ name: 'p', keywords: 'x' }, '/x/p').keywords).toBeUndefined();
    expect(validateManifest({ name: 'p', keywords: [1, 2] }, '/x/p').keywords).toBeUndefined();
  });

  it('does not pollute Object.prototype via __proto__/constructor keys', () => {
    const m = validateManifest(
      { name: 'p', ['__proto__']: { polluted: true }, constructor: { x: 1 } },
      '/x/p',
    );
    expect((m as unknown as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect((Object.prototype as unknown as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('rejects a name containing a newline (no multiline regex bypass)', () => {
    expect(() => validateManifest({ name: 'good\n../../etc' }, '/x/p')).toThrow(/kebab-case/);
  });

  it('drops version/description when not a string', () => {
    const m = validateManifest({ name: 'p', version: 1, description: ['x'] }, '/x/p');
    expect(m.version).toBeUndefined();
    expect(m.description).toBeUndefined();
  });

  it('drops skills/commands when given a non-array, non-string value', () => {
    const m = validateManifest({ name: 'p', skills: 1, commands: 2 }, '/x/p');
    expect(m.skills).toBeUndefined();
    expect(m.commands).toBeUndefined();
  });

  it('drops agents when given a non-array, non-string value', () => {
    expect(validateManifest({ name: 'p', agents: 1 }, '/x/p').agents).toBeUndefined();
  });
});

describe('readManifest', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cc-plugin-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads and validates .claude-plugin/plugin.json', async () => {
    await mkdir(join(dir, MANIFEST_DIR), { recursive: true });
    await writeFile(
      join(dir, MANIFEST_DIR, MANIFEST_FILENAME),
      JSON.stringify({ name: 'disco', version: '1.2.0' }),
    );
    const m = await readManifest(dir);
    expect(m.name).toBe('disco');
    expect(m.version).toBe('1.2.0');
  });

  it('derives a manifest from the dir name when the file is absent (optional manifest)', async () => {
    const sub = join(dir, 'auto-named');
    await mkdir(sub, { recursive: true });
    const m = await readManifest(sub);
    expect(m.name).toBe('auto-named');
  });

  it('throws on invalid JSON', async () => {
    await mkdir(join(dir, MANIFEST_DIR), { recursive: true });
    await writeFile(join(dir, MANIFEST_DIR, MANIFEST_FILENAME), '{ not json');
    await expect(readManifest(dir)).rejects.toThrow(/invalid JSON/);
  });
});

describe('resolveSkillDirs', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cc-skills-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('includes the default skills/ dir when present and adds manifest paths', async () => {
    await mkdir(join(dir, 'skills'), { recursive: true });
    await mkdir(join(dir, 'extra'), { recursive: true });
    const dirs = resolveSkillDirs(dir, { name: 'p', skills: ['./extra'] });
    expect(dirs).toEqual([join(dir, 'skills'), join(dir, 'extra')]);
  });

  it('returns empty when no skills dir exists', () => {
    const dirs = resolveSkillDirs(dir, { name: 'p' });
    expect(dirs).toEqual([]);
  });

  it('ignores non-relative or missing manifest skill paths', async () => {
    await mkdir(join(dir, 'skills'), { recursive: true });
    const dirs = resolveSkillDirs(dir, { name: 'p', skills: ['/abs/path', './missing'] });
    expect(dirs).toEqual([join(dir, 'skills')]);
  });

  it('rejects a manifest skill path that escapes the plugin root via path traversal', async () => {
    // Set up: <tmpParent>/plug/ as the plugin root (with skills/) and
    // <tmpParent>/escape/ as the escape target outside the plugin root.
    const tmpParent = await mkdtemp(join(tmpdir(), 'cc-escape-'));
    const plugDir = join(tmpParent, 'plug');
    const escapeDir = join(tmpParent, 'escape');
    await mkdir(join(plugDir, 'skills'), { recursive: true });
    await mkdir(escapeDir, { recursive: true });
    try {
      // './../escape' resolves to <tmpParent>/escape — outside plugDir
      const dirs = resolveSkillDirs(plugDir, { name: 'p', skills: ['./../escape'] });
      expect(dirs).toEqual([join(plugDir, 'skills')]);
    } finally {
      await rm(tmpParent, { recursive: true, force: true });
    }
  });
});

describe('resolveCommandFiles', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cc-cmd-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('finds flat .md files under the default commands/ dir', async () => {
    await mkdir(join(dir, 'commands'), { recursive: true });
    await writeFile(join(dir, 'commands', 'deploy.md'), '# deploy');
    await writeFile(join(dir, 'commands', 'rollback.md'), '# rollback');
    await writeFile(join(dir, 'commands', 'notes.txt'), 'ignore me');
    const files = resolveCommandFiles(dir, { name: 'p' }).sort();
    expect(files).toEqual([
      join(dir, 'commands', 'deploy.md'),
      join(dir, 'commands', 'rollback.md'),
    ]);
  });

  it('manifest commands REPLACES the default dir', async () => {
    await mkdir(join(dir, 'commands'), { recursive: true });
    await writeFile(join(dir, 'commands', 'default.md'), 'x');
    await mkdir(join(dir, 'custom'), { recursive: true });
    await writeFile(join(dir, 'custom', 'special.md'), 'y');
    const files = resolveCommandFiles(dir, { name: 'p', commands: ['./custom'] });
    expect(files).toEqual([join(dir, 'custom', 'special.md')]);
  });

  it('returns [] when no commands dir exists', () => {
    expect(resolveCommandFiles(dir, { name: 'p' })).toEqual([]);
  });
});

describe('resolveAgentFiles', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cc-agent-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('finds flat .md files under the default agents/ dir', async () => {
    await mkdir(join(dir, 'agents'), { recursive: true });
    await writeFile(join(dir, 'agents', 'reviewer.md'), '# reviewer');
    await writeFile(join(dir, 'agents', 'planner.md'), '# planner');
    await writeFile(join(dir, 'agents', 'notes.txt'), 'ignore me');
    const files = resolveAgentFiles(dir, { name: 'p' }).sort();
    expect(files).toEqual([join(dir, 'agents', 'planner.md'), join(dir, 'agents', 'reviewer.md')]);
  });

  it('manifest agents ADDS to the default dir', async () => {
    await mkdir(join(dir, 'agents'), { recursive: true });
    await writeFile(join(dir, 'agents', 'default.md'), 'x');
    await mkdir(join(dir, 'custom'), { recursive: true });
    await writeFile(join(dir, 'custom', 'special.md'), 'y');
    const files = resolveAgentFiles(dir, { name: 'p', agents: ['./custom'] }).sort();
    expect(files).toEqual([join(dir, 'agents', 'default.md'), join(dir, 'custom', 'special.md')]);
  });

  it('uses a manifest agents path that points directly at an .md file', async () => {
    await writeFile(join(dir, 'lone.md'), 'z');
    const files = resolveAgentFiles(dir, { name: 'p', agents: ['./lone.md'] });
    expect(files).toEqual([join(dir, 'lone.md')]);
  });

  it('returns [] when no agents dir exists', () => {
    expect(resolveAgentFiles(dir, { name: 'p' })).toEqual([]);
  });

  it('ignores non-relative or missing manifest agent paths', async () => {
    await mkdir(join(dir, 'agents'), { recursive: true });
    await writeFile(join(dir, 'agents', 'a.md'), 'a');
    const files = resolveAgentFiles(dir, { name: 'p', agents: ['/abs/path', './missing'] });
    expect(files).toEqual([join(dir, 'agents', 'a.md')]);
  });
});

describe('resolveBinDir', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cc-bin-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns the bin/ dir when present, undefined otherwise', async () => {
    expect(resolveBinDir(dir)).toBeUndefined();
    await mkdir(join(dir, 'bin'), { recursive: true });
    expect(resolveBinDir(dir)).toBe(join(dir, 'bin'));
  });
});
