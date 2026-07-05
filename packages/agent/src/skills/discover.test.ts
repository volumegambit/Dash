import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  it('discovers managed skills', async () => {
    await writeSkill(managed, 'mytest', 'a managed skill');
    const skills = await discoverSkills({ managedSkillsDir: managed });
    expect(skills.some((s) => s.name === 'mytest' && s.source === 'managed')).toBe(true);
    expect(skills).toHaveLength(1);
  });

  it('lets a per-agent skill override a configured-path skill with the same name', async () => {
    const extra = await mkdtemp(join(tmpdir(), 'dash-skills-paths-'));
    try {
      const shadowName = 'shared-skill';
      await writeSkill(extra, shadowName, 'CONFIGURED PATH');
      await writeSkill(managed, shadowName, 'SHADOW OVERRIDE');
      const matches = (await discoverSkills({ managedSkillsDir: managed, paths: [extra] })).filter(
        (s) => s.name === shadowName,
      );
      expect(matches).toHaveLength(1);
      expect(matches[0].source).toBe('managed');
      expect(matches[0].description).toBe('SHADOW OVERRIDE');
    } finally {
      await rm(extra, { recursive: true, force: true });
    }
  });

  it('discovers skills from configured paths', async () => {
    const extra = await mkdtemp(join(tmpdir(), 'dash-skills-paths-'));
    try {
      await writeSkill(extra, 'from-path', 'a path skill');
      const skills = await discoverSkills({ paths: [extra] });
      expect(skills.map((s) => s.name)).toEqual(['from-path']);
    } finally {
      await rm(extra, { recursive: true, force: true });
    }
  });
});
