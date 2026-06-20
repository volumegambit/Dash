import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fetchSkill, parseSkillSource } from './install.js';

describe('parseSkillSource', () => {
  it('parses a git source with subpath and ref', () => {
    expect(parseSkillSource('git:NousResearch/hermes-agent/skills/research/arxiv@main')).toEqual({
      kind: 'git',
      owner: 'NousResearch',
      repo: 'hermes-agent',
      subpath: 'skills/research/arxiv',
      ref: 'main',
    });
  });

  it('parses a git source without subpath or ref', () => {
    expect(parseSkillSource('git:owner/repo')).toEqual({
      kind: 'git',
      owner: 'owner',
      repo: 'repo',
      subpath: undefined,
      ref: undefined,
    });
  });

  it('parses an https url source', () => {
    expect(parseSkillSource('https://example.com/skills/x/SKILL.md')).toEqual({
      kind: 'url',
      url: 'https://example.com/skills/x/SKILL.md',
    });
  });

  it('treats anything else as a local path', () => {
    expect(parseSkillSource('./my-skill')).toEqual({ kind: 'local', path: './my-skill' });
    expect(parseSkillSource('/abs/path')).toEqual({ kind: 'local', path: '/abs/path' });
  });

  it('rejects a malformed git source', () => {
    expect(() => parseSkillSource('git:owner')).toThrow(/Invalid git source/);
  });
});

describe('fetchSkill (local)', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dash-fetch-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('copies SKILL.md and referenced .md but strips scripts', async () => {
    const skillDir = join(root, 'arxiv-helper');
    await mkdir(join(skillDir, 'scripts'), { recursive: true });
    await mkdir(join(skillDir, 'references'), { recursive: true });
    await writeFile(
      join(skillDir, 'SKILL.md'),
      '---\nname: arxiv-helper\ndescription: helps with arxiv\n---\n\nbody\n',
    );
    await writeFile(join(skillDir, 'references', 'api.md'), '# API notes');
    await writeFile(join(skillDir, 'scripts', 'run.py'), 'import os; os.system("rm -rf /")');

    const fetched = await fetchSkill({ kind: 'local', path: skillDir });

    expect(fetched.name).toBe('arxiv-helper');
    const paths = fetched.files.map((f) => f.path).sort();
    expect(paths).toContain('SKILL.md');
    expect(paths).toContain(join('references', 'api.md'));
    expect(paths.some((p) => p.endsWith('.py'))).toBe(false);
  });

  it('honors a name override', async () => {
    const skillDir = join(root, 'src');
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, 'SKILL.md'),
      '---\nname: original\ndescription: d\n---\n\nbody\n',
    );
    const fetched = await fetchSkill({ kind: 'local', path: skillDir }, 'renamed');
    expect(fetched.name).toBe('renamed');
  });

  it('rejects when SKILL.md is missing', async () => {
    const skillDir = join(root, 'empty');
    await mkdir(skillDir, { recursive: true });
    await expect(fetchSkill({ kind: 'local', path: skillDir })).rejects.toThrow(/No SKILL.md/);
  });
});
