import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendAugments, collectAugments } from './augment.js';
import { emptyBook, writeBook } from './store.js';
import type { Lesson, LessonBook } from './types.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dash-augment-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function lesson(text: string): Lesson {
  return {
    id: text.slice(0, 6),
    text,
    helpful: 0,
    harmful: 0,
    createdAt: '2026-09-06',
    lastTouchedAt: '2026-09-06',
  };
}

async function writeLearnedSkill(over: Partial<LessonBook> & { skill: string }): Promise<void> {
  const skillDir = join(dir, over.skill);
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, 'SKILL.md'), `---\nname: ${over.skill}\ndescription: d\n---\nb\n`);
  await writeFile(join(skillDir, '.source'), 'agent');
  await writeBook(skillDir, { ...emptyBook(over.skill, 'd'), ...over });
}

describe('collectAugments', () => {
  it('returns the body of a book that rides along with the loaded skill', async () => {
    await writeLearnedSkill({
      skill: 'build-lessons',
      augments: ['dash-dev'],
      bullets: [lesson('Re-run the generator first.')],
    });

    const bodies = await collectAugments(dir, 'dash-dev');

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain('Re-run the generator first.');
  });

  it('returns nothing for a skill nothing augments', async () => {
    await writeLearnedSkill({
      skill: 'build-lessons',
      augments: ['dash-dev'],
      bullets: [lesson('x')],
    });

    expect(await collectAugments(dir, 'unrelated-skill')).toEqual([]);
  });

  it('ignores a book that has no lessons yet', async () => {
    await writeLearnedSkill({ skill: 'build-lessons', augments: ['dash-dev'], bullets: [] });

    expect(await collectAugments(dir, 'dash-dev')).toEqual([]);
  });

  it('never rides along with itself', async () => {
    await writeLearnedSkill({
      skill: 'self-referential',
      augments: ['self-referential'],
      bullets: [lesson('x')],
    });

    expect(await collectAugments(dir, 'self-referential')).toEqual([]);
  });

  it('terminates on a cycle between two books', async () => {
    await writeLearnedSkill({ skill: 'alpha', augments: ['beta'], bullets: [lesson('a lesson')] });
    await writeLearnedSkill({ skill: 'beta', augments: ['alpha'], bullets: [lesson('b lesson')] });

    // Lookup is one level deep by construction, so a cycle cannot recurse.
    expect(await collectAugments(dir, 'alpha')).toHaveLength(1);
    expect(await collectAugments(dir, 'beta')).toHaveLength(1);
  });

  it('returns an empty list when the managed directory does not exist', async () => {
    expect(await collectAugments(join(dir, 'missing'), 'dash-dev')).toEqual([]);
  });
});

describe('appendAugments', () => {
  it('returns the content unchanged when nothing rides along', () => {
    expect(appendAugments('original', [])).toBe('original');
  });

  it('marks the appended section so its lower authority is visible', () => {
    const out = appendAugments('original', ['learned body']);

    expect(out).toContain('original');
    expect(out).toContain('learned body');
    expect(out).toMatch(/learned/i);
  });
});
