import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createSkillInDir,
  installSkillToDir,
  removeSkillFromDir,
  updateSkillBody,
} from './manage.js';
import type { SkillSecurityScanner } from './security.js';
import type { SkillDiscoveryResult } from './types.js';

const safeScanner: SkillSecurityScanner = async () => ({ verdict: 'safe', reasons: [] });

describe('createSkillInDir', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dash-mng-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes SKILL.md + .source=agent', async () => {
    const r = await createSkillInDir({
      managedDir: dir,
      name: 'foo',
      description: 'd',
      content: 'body',
    });
    expect(r.name).toBe('foo');
    expect(existsSync(join(dir, 'foo', 'SKILL.md'))).toBe(true);
    expect((await readFile(join(dir, 'foo', '.source'), 'utf-8')).trim()).toBe('agent');
  });

  it('rejects an invalid name', async () => {
    await expect(
      createSkillInDir({ managedDir: dir, name: 'Bad Name', description: 'd', content: 'b' }),
    ).rejects.toMatchObject({ code: 'invalid' });
  });

  it('rejects empty content', async () => {
    await expect(
      createSkillInDir({ managedDir: dir, name: 'foo', description: 'd', content: '   ' }),
    ).rejects.toMatchObject({ code: 'invalid' });
  });

  it('rejects a duplicate', async () => {
    await createSkillInDir({ managedDir: dir, name: 'foo', description: 'd', content: 'b' });
    await expect(
      createSkillInDir({ managedDir: dir, name: 'foo', description: 'd', content: 'b' }),
    ).rejects.toMatchObject({ code: 'duplicate' });
  });
});

describe('updateSkillBody', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dash-mng-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('replaces the body but preserves frontmatter', async () => {
    await createSkillInDir({
      managedDir: dir,
      name: 'foo',
      description: 'keepme',
      content: 'old body',
    });
    await updateSkillBody({ managedDir: dir, name: 'foo', body: 'NEW BODY' });
    const raw = await readFile(join(dir, 'foo', 'SKILL.md'), 'utf-8');
    expect(raw).toContain('description: keepme');
    expect(raw).toContain('NEW BODY');
    expect(raw).not.toContain('old body');
  });

  it('rejects a missing skill', async () => {
    await expect(
      updateSkillBody({ managedDir: dir, name: 'nope', body: 'x' }),
    ).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});

describe('installSkillToDir', () => {
  let root: string;
  let managed: string;
  let src: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dash-mng-'));
    managed = join(root, 'managed');
    await mkdir(managed, { recursive: true });
    src = join(root, 'fix', 'arxiv');
    await mkdir(src, { recursive: true });
    await writeFile(join(src, 'SKILL.md'), '---\nname: arxiv\ndescription: d\n---\n\nbody\n');
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('installs a safe skill with .source=remote', async () => {
    const r = await installSkillToDir({ managedDir: managed, source: src, scanner: safeScanner });
    expect(r.name).toBe('arxiv');
    expect((await readFile(join(managed, 'arxiv', '.source'), 'utf-8')).trim()).toBe('remote');
  });

  it('refuses a dangerous skill (writes nothing)', async () => {
    const scanner: SkillSecurityScanner = async () => ({ verdict: 'dangerous', reasons: ['x'] });
    await expect(
      installSkillToDir({ managedDir: managed, source: src, scanner }),
    ).rejects.toMatchObject({ code: 'dangerous' });
    expect(existsSync(join(managed, 'arxiv'))).toBe(false);
  });

  it('fails closed when the scanner throws', async () => {
    const scanner: SkillSecurityScanner = async () => {
      throw new Error('down');
    };
    await expect(
      installSkillToDir({ managedDir: managed, source: src, scanner }),
    ).rejects.toMatchObject({ code: 'scan_failed' });
    expect(existsSync(join(managed, 'arxiv'))).toBe(false);
  });

  it('rejects a duplicate', async () => {
    await installSkillToDir({ managedDir: managed, source: src, scanner: safeScanner });
    await expect(
      installSkillToDir({ managedDir: managed, source: src, scanner: safeScanner }),
    ).rejects.toMatchObject({ code: 'duplicate' });
  });
});

describe('removeSkillFromDir', () => {
  let managed: string;
  beforeEach(async () => {
    managed = await mkdtemp(join(tmpdir(), 'dash-mng-'));
  });
  afterEach(async () => {
    await rm(managed, { recursive: true, force: true });
  });

  it('removes a managed skill', async () => {
    await createSkillInDir({ managedDir: managed, name: 'foo', description: 'd', content: 'b' });
    const list = async (): Promise<SkillDiscoveryResult[]> => [
      { name: 'foo', description: 'd', location: '', content: '', editable: true, source: 'agent' },
    ];
    await removeSkillFromDir({ managedDir: managed, name: 'foo', listFn: list });
    expect(existsSync(join(managed, 'foo'))).toBe(false);
  });

  it('refuses to remove a bundled skill', async () => {
    const list = async (): Promise<SkillDiscoveryResult[]> => [
      {
        name: 'deep-research',
        description: 'd',
        location: '',
        content: '',
        editable: false,
        source: 'bundled',
      },
    ];
    await expect(
      removeSkillFromDir({ managedDir: managed, name: 'deep-research', listFn: list }),
    ).rejects.toMatchObject({ code: 'bundled' });
  });

  it('rejects a missing skill', async () => {
    await expect(
      removeSkillFromDir({ managedDir: managed, name: 'nope', listFn: async () => [] }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});
