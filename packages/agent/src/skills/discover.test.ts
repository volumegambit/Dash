import { readdirSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getBundledSkillsDir } from '@dash/skills';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverSkills } from './discover.js';

async function writeSkill(dir: string, name: string, description: string): Promise<void> {
  const d = join(dir, name);
  await mkdir(d, { recursive: true });
  await writeFile(
    join(d, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\nbody\n`,
    'utf-8',
  );
}

describe('discoverSkills', () => {
  let managed: string;

  beforeEach(async () => {
    managed = await mkdtemp(join(tmpdir(), 'dash-skills-'));
  });

  afterEach(async () => {
    await rm(managed, { recursive: true, force: true });
  });

  it('includes bundled skills alongside managed skills by default', async () => {
    await writeSkill(managed, 'mytest', 'a managed skill');
    const skills = await discoverSkills({ managedSkillsDir: managed });
    expect(skills.some((s) => s.name === 'mytest' && s.source === 'managed')).toBe(true);
    expect(skills.some((s) => s.source === 'bundled')).toBe(true);
    expect(skills.length).toBeGreaterThan(1);
  });

  it('excludes the bundled tier when includeBundled is false', async () => {
    await writeSkill(managed, 'mytest', 'a managed skill');
    const skills = await discoverSkills({ managedSkillsDir: managed, includeBundled: false });
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('mytest');
  });

  it('lets a per-agent skill override a bundled skill with the same name', async () => {
    // Pick a real bundled skill name to shadow.
    const bundledDir = getBundledSkillsDir();
    const suite = readdirSync(bundledDir, { withFileTypes: true }).find((e) => e.isDirectory());
    if (!suite) throw new Error('no bundled suites found');
    const skill = readdirSync(join(bundledDir, suite.name), { withFileTypes: true }).find((e) =>
      e.isDirectory(),
    );
    if (!skill) throw new Error('no bundled skills found');
    const shadowName = skill.name;

    await writeSkill(managed, shadowName, 'SHADOW OVERRIDE');
    const matches = (await discoverSkills({ managedSkillsDir: managed })).filter(
      (s) => s.name === shadowName,
    );
    expect(matches).toHaveLength(1);
    expect(matches[0].source).toBe('managed');
    expect(matches[0].description).toBe('SHADOW OVERRIDE');
  });

  it('discovers skills from configured paths', async () => {
    const extra = await mkdtemp(join(tmpdir(), 'dash-skills-paths-'));
    try {
      await writeSkill(extra, 'from-path', 'a path skill');
      const skills = await discoverSkills({ paths: [extra], includeBundled: false });
      expect(skills.map((s) => s.name)).toEqual(['from-path']);
    } finally {
      await rm(extra, { recursive: true, force: true });
    }
  });
});
