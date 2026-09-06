import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emptyBook, listBooks, persistBook, readBook, writeBook } from './store.js';
import { LESSONS_FILENAME, type LessonBook } from './types.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dash-lessons-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** An agent-owned skill directory: SKILL.md plus the `.source` marker. */
async function makeAgentSkill(name: string): Promise<string> {
  const skillDir = join(dir, name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\nbody\n`);
  await writeFile(join(skillDir, '.source'), 'agent');
  return skillDir;
}

/** A managed skill the user wrote: no `.source` marker. */
async function makeUserSkill(name: string): Promise<string> {
  const skillDir = join(dir, name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\nbody\n`);
  return skillDir;
}

describe('emptyBook', () => {
  it('builds a v1 book with no lessons', () => {
    const book = emptyBook('debugging-builds', 'Use when a build fails');
    expect(book.version).toBe(1);
    expect(book.skill).toBe('debugging-builds');
    expect(book.description).toBe('Use when a build fails');
    expect(book.bullets).toEqual([]);
    expect(book.retired).toEqual([]);
    expect(book.augments).toEqual([]);
  });
});

describe('writeBook / readBook', () => {
  it('round-trips a book through disk', async () => {
    const skillDir = await makeAgentSkill('debugging-builds');
    const book: LessonBook = {
      ...emptyBook('debugging-builds', 'Use when a build fails'),
      bullets: [
        {
          id: 'b7f2a1',
          text: 'Re-run the generator after adding a source file.',
          helpful: 3,
          harmful: 0,
          createdAt: '2026-09-06',
          lastTouchedAt: '2026-09-06',
        },
      ],
    };

    await writeBook(skillDir, book);
    const read = await readBook(skillDir);

    expect(read).toEqual(book);
  });

  it('writes the book as formatted JSON so it is reviewable by hand', async () => {
    const skillDir = await makeAgentSkill('a-skill');
    await writeBook(skillDir, emptyBook('a-skill', 'd'));
    const raw = await readFile(join(skillDir, LESSONS_FILENAME), 'utf-8');
    expect(raw).toContain('\n  ');
    expect(raw.endsWith('\n')).toBe(true);
  });

  it('leaves no temp file behind (the write is temp-then-rename)', async () => {
    const skillDir = await makeAgentSkill('a-skill');
    await writeBook(skillDir, emptyBook('a-skill', 'd'));
    const entries = await readdir(skillDir);
    expect(entries.some((e) => e.includes('.tmp-'))).toBe(false);
    expect(entries).toContain(LESSONS_FILENAME);
  });

  it('returns null when the skill has no lesson book yet', async () => {
    const skillDir = await makeAgentSkill('a-skill');
    expect(await readBook(skillDir)).toBeNull();
  });

  it('returns null for a directory that does not exist', async () => {
    expect(await readBook(join(dir, 'nope'))).toBeNull();
  });
});

describe('ownership enforcement', () => {
  it('refuses to write to a skill the agent does not own', async () => {
    const skillDir = await makeUserSkill('user-authored');
    await expect(writeBook(skillDir, emptyBook('user-authored', 'd'))).rejects.toThrow(
      /does not own/i,
    );
    expect(existsSync(join(skillDir, LESSONS_FILENAME))).toBe(false);
  });

  it('refuses to write when the source marker names another owner', async () => {
    const skillDir = await makeAgentSkill('remote-skill');
    await writeFile(join(skillDir, '.source'), 'remote');
    await expect(writeBook(skillDir, emptyBook('remote-skill', 'd'))).rejects.toThrow(
      /does not own/i,
    );
  });

  it('refuses to read a book from a skill the agent does not own', async () => {
    // A book planted beside a user-authored skill must not be honoured: the
    // marker is the authority, not the presence of the file.
    const skillDir = await makeUserSkill('user-authored');
    await writeFile(
      join(skillDir, LESSONS_FILENAME),
      JSON.stringify(emptyBook('user-authored', 'd')),
    );
    expect(await readBook(skillDir)).toBeNull();
  });
});

describe('corrupt books', () => {
  it('quarantines an unparseable book instead of throwing', async () => {
    const skillDir = await makeAgentSkill('a-skill');
    await writeFile(join(skillDir, LESSONS_FILENAME), '{ not json');

    expect(await readBook(skillDir)).toBeNull();

    const entries = await readdir(skillDir);
    expect(entries.some((e) => e.startsWith('lessons.json.corrupt-'))).toBe(true);
    expect(entries).not.toContain(LESSONS_FILENAME);
  });

  it('quarantines a book whose shape is wrong', async () => {
    const skillDir = await makeAgentSkill('a-skill');
    await writeFile(join(skillDir, LESSONS_FILENAME), JSON.stringify({ version: 1 }));

    expect(await readBook(skillDir)).toBeNull();
    const entries = await readdir(skillDir);
    expect(entries.some((e) => e.startsWith('lessons.json.corrupt-'))).toBe(true);
  });
});

describe('listBooks', () => {
  it('returns only agent-owned skills that have a book', async () => {
    const owned = await makeAgentSkill('owned');
    await writeBook(owned, emptyBook('owned', 'd'));
    await makeAgentSkill('owned-no-book');
    const user = await makeUserSkill('user-authored');
    await writeFile(join(user, LESSONS_FILENAME), JSON.stringify(emptyBook('user-authored', 'd')));

    const books = await listBooks(dir);

    expect(books.map((b) => b.skill)).toEqual(['owned']);
  });

  it('returns an empty list when the managed directory does not exist', async () => {
    expect(await listBooks(join(dir, 'missing'))).toEqual([]);
  });
});

describe('persistBook', () => {
  it('creates the skill directory, the marker, the book and a rendered SKILL.md', async () => {
    const b: LessonBook = {
      ...emptyBook('learned-skill', 'Use when a build fails'),
      bullets: [
        {
          id: 'aaa111',
          text: 'Re-run the generator first.',
          helpful: 0,
          harmful: 0,
          createdAt: '2026-09-06',
          lastTouchedAt: '2026-09-06',
        },
      ],
    };

    await persistBook(dir, b);

    const skillDir = join(dir, 'learned-skill');
    expect((await readFile(join(skillDir, '.source'), 'utf-8')).trim()).toBe('agent');
    expect(await readBook(skillDir)).toEqual(b);

    const md = await readFile(join(skillDir, 'SKILL.md'), 'utf-8');
    expect(md).toContain('name: learned-skill');
    expect(md).toContain('Re-run the generator first.');
  });

  it('updates an existing learned skill in place', async () => {
    const first = emptyBook('learned-skill', 'd');
    await persistBook(dir, first);

    const second: LessonBook = {
      ...first,
      bullets: [
        {
          id: 'bbb222',
          text: 'A second lesson.',
          helpful: 1,
          harmful: 0,
          createdAt: '2026-09-06',
          lastTouchedAt: '2026-09-06',
        },
      ],
    };
    await persistBook(dir, second);

    const skillDir = join(dir, 'learned-skill');
    expect((await readBook(skillDir))?.bullets).toHaveLength(1);
    expect(await readFile(join(skillDir, 'SKILL.md'), 'utf-8')).toContain('A second lesson.');
  });

  it('refuses to overwrite a skill the agent does not own', async () => {
    await makeUserSkill('user-authored');

    await expect(persistBook(dir, emptyBook('user-authored', 'd'))).rejects.toThrow(
      /does not own/i,
    );
  });
});
