import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUNDLED_SUITES, getBundledSkillsDir } from './index.js';

interface BundledSkillFile {
  suite: string;
  name: string;
  file: string;
}

function listSkillFiles(dir: string): BundledSkillFile[] {
  const out: BundledSkillFile[] = [];
  for (const suite of readdirSync(dir, { withFileTypes: true })) {
    if (!suite.isDirectory()) continue;
    const suiteDir = join(dir, suite.name);
    for (const skill of readdirSync(suiteDir, { withFileTypes: true })) {
      if (!skill.isDirectory()) continue;
      const file = join(suiteDir, skill.name, 'SKILL.md');
      if (existsSync(file)) out.push({ suite: suite.name, name: skill.name, file });
    }
  }
  return out;
}

function parseFrontmatter(raw: string): Record<string, string> {
  const m = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const fm: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const mm = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (mm) fm[mm[1]] = mm[2].trim().replace(/^["']|["']$/g, '');
  }
  return fm;
}

describe('bundled skills library', () => {
  const dir = getBundledSkillsDir();
  const skills = listSkillFiles(dir);

  it('ships at least 15 skills', () => {
    expect(skills.length).toBeGreaterThanOrEqual(15);
  });

  it('each skill has valid frontmatter with name matching its directory', () => {
    for (const s of skills) {
      const fm = parseFrontmatter(readFileSync(s.file, 'utf-8'));
      expect(fm.name, `${s.file}: name must equal directory`).toBe(s.name);
      expect(
        (fm.description ?? '').length,
        `${s.file}: description must be non-empty`,
      ).toBeGreaterThan(0);
    }
  });

  it('skill names are globally unique', () => {
    const names = skills.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('only uses declared suites', () => {
    for (const s of skills) {
      expect(BUNDLED_SUITES as readonly string[]).toContain(s.suite);
    }
  });
});
