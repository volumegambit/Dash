import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MANIFEST_DIR,
  MANIFEST_FILENAME,
  readManifest,
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
});
