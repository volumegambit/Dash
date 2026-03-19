import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scanSkillsDirectory } from './scanner.js';

const VALID_SKILL_MD = `---
name: my-skill
description: Does something useful
trigger: /my-skill
---

# My Skill

This is the skill content.`;

const VALID_SKILL_MD_2 = `---
name: another-skill
description: Another useful skill
---

# Another Skill

This is another skill.`;

const INVALID_SKILL_MD = `---
description: Missing name field
---

Content.`;

let tmpDir: string;

beforeEach(async () => {
  tmpDir = join(tmpdir(), `scanner-test-${Date.now()}`);
  await mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('scanSkillsDirectory', () => {
  it('returns empty array for nonexistent directory', async () => {
    const results = await scanSkillsDirectory('/nonexistent/path/that/does/not/exist', 'managed');
    expect(results).toEqual([]);
  });

  it('returns empty array for an empty directory', async () => {
    const results = await scanSkillsDirectory(tmpDir, 'managed');
    expect(results).toEqual([]);
  });

  it('discovers a skill in a subdirectory with SKILL.md', async () => {
    const skillDir = join(tmpDir, 'my-skill');
    await mkdir(skillDir);
    await writeFile(join(skillDir, 'SKILL.md'), VALID_SKILL_MD, 'utf-8');

    const results = await scanSkillsDirectory(tmpDir, 'managed');
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('my-skill');
    expect(results[0].description).toBe('Does something useful');
    expect(results[0].trigger).toBe('/my-skill');
    expect(results[0].location).toBe(join(skillDir, 'SKILL.md'));
    expect(results[0].editable).toBe(true);
    expect(results[0].source).toBe('managed');
  });

  it('skips subdirectories without SKILL.md', async () => {
    const skillDir = join(tmpDir, 'not-a-skill');
    await mkdir(skillDir);
    await writeFile(join(skillDir, 'README.md'), '# Not a skill', 'utf-8');

    const results = await scanSkillsDirectory(tmpDir, 'managed');
    expect(results).toEqual([]);
  });

  it('skips files at the top level (only scans subdirectories)', async () => {
    await writeFile(join(tmpDir, 'SKILL.md'), VALID_SKILL_MD, 'utf-8');

    const results = await scanSkillsDirectory(tmpDir, 'managed');
    expect(results).toEqual([]);
  });

  it('skips skills with invalid frontmatter (no name)', async () => {
    const skillDir = join(tmpDir, 'invalid-skill');
    await mkdir(skillDir);
    await writeFile(join(skillDir, 'SKILL.md'), INVALID_SKILL_MD, 'utf-8');

    const results = await scanSkillsDirectory(tmpDir, 'managed');
    expect(results).toEqual([]);
  });

  it('discovers multiple skills', async () => {
    const skillDir1 = join(tmpDir, 'skill-one');
    const skillDir2 = join(tmpDir, 'skill-two');
    await mkdir(skillDir1);
    await mkdir(skillDir2);
    await writeFile(join(skillDir1, 'SKILL.md'), VALID_SKILL_MD, 'utf-8');
    await writeFile(join(skillDir2, 'SKILL.md'), VALID_SKILL_MD_2, 'utf-8');

    const results = await scanSkillsDirectory(tmpDir, 'managed');
    expect(results).toHaveLength(2);

    const names = results.map((r) => r.name).sort();
    expect(names).toEqual(['another-skill', 'my-skill']);
  });

  it('uses defaultSource when no .source marker file is present', async () => {
    const skillDir = join(tmpDir, 'remote-skill');
    await mkdir(skillDir);
    await writeFile(join(skillDir, 'SKILL.md'), VALID_SKILL_MD, 'utf-8');

    const results = await scanSkillsDirectory(tmpDir, 'remote');
    expect(results).toHaveLength(1);
    expect(results[0].source).toBe('remote');
  });

  it('discovers agent-created skills via .source marker file', async () => {
    const skillDir = join(tmpDir, 'agent-skill');
    await mkdir(skillDir);
    await writeFile(join(skillDir, 'SKILL.md'), VALID_SKILL_MD, 'utf-8');
    await writeFile(join(skillDir, '.source'), 'agent', 'utf-8');

    const results = await scanSkillsDirectory(tmpDir, 'managed');
    expect(results).toHaveLength(1);
    expect(results[0].source).toBe('agent');
  });

  it('uses defaultSource when .source marker contains a non-agent value', async () => {
    const skillDir = join(tmpDir, 'other-skill');
    await mkdir(skillDir);
    await writeFile(join(skillDir, 'SKILL.md'), VALID_SKILL_MD, 'utf-8');
    await writeFile(join(skillDir, '.source'), 'something-else', 'utf-8');

    const results = await scanSkillsDirectory(tmpDir, 'managed');
    expect(results).toHaveLength(1);
    expect(results[0].source).toBe('managed');
  });

  it('includes content from SKILL.md body', async () => {
    const skillDir = join(tmpDir, 'content-skill');
    await mkdir(skillDir);
    await writeFile(join(skillDir, 'SKILL.md'), VALID_SKILL_MD, 'utf-8');

    const results = await scanSkillsDirectory(tmpDir, 'managed');
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe('# My Skill\n\nThis is the skill content.');
  });

  it('handles mix of valid and invalid skill directories', async () => {
    const validDir = join(tmpDir, 'valid-skill');
    const invalidDir = join(tmpDir, 'invalid-skill');
    const noSkillDir = join(tmpDir, 'not-a-skill');

    await mkdir(validDir);
    await mkdir(invalidDir);
    await mkdir(noSkillDir);

    await writeFile(join(validDir, 'SKILL.md'), VALID_SKILL_MD, 'utf-8');
    await writeFile(join(invalidDir, 'SKILL.md'), INVALID_SKILL_MD, 'utf-8');
    await writeFile(join(noSkillDir, 'README.md'), '# Not a skill', 'utf-8');

    const results = await scanSkillsDirectory(tmpDir, 'managed');
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('my-skill');
  });
});
