import { existsSync } from 'node:fs';
import { readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { SkillOpError, createSkillInDir } from '../manage.js';
import { GENERATED_MARKER, renderSkillBody, renderSkillFile } from './render.js';
import {
  AGENT_SOURCE,
  LESSONS_FILENAME,
  LESSON_BOOK_VERSION,
  type Lesson,
  type LessonBook,
  type RetiredLesson,
  SOURCE_FILENAME,
} from './types.js';

/** Today as `YYYY-MM-DD` (UTC), matching the memory store's convention. */
export function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function emptyBook(skill: string, description: string): LessonBook {
  return {
    version: LESSON_BOOK_VERSION,
    skill,
    description,
    augments: [],
    bullets: [],
    retired: [],
  };
}

/**
 * Whether the agent owns this skill directory.
 *
 * The `.source` marker is the authority — not the presence of a lesson book, and
 * not the directory's location. A book planted beside a user-authored skill is
 * ignored, so a model that ignores its instructions still cannot reach a skill
 * the user or a plugin owns.
 */
export async function isAgentOwned(skillDir: string): Promise<boolean> {
  try {
    const marker = await readFile(join(skillDir, SOURCE_FILENAME), 'utf-8');
    return marker.trim() === AGENT_SOURCE;
  } catch {
    return false;
  }
}

function isLesson(value: unknown): value is Lesson {
  if (typeof value !== 'object' || value === null) return false;
  const l = value as Record<string, unknown>;
  return (
    typeof l.id === 'string' &&
    typeof l.text === 'string' &&
    typeof l.helpful === 'number' &&
    typeof l.harmful === 'number' &&
    typeof l.createdAt === 'string' &&
    typeof l.lastTouchedAt === 'string'
  );
}

function isBook(value: unknown): value is LessonBook {
  if (typeof value !== 'object' || value === null) return false;
  const b = value as Record<string, unknown>;
  return (
    b.version === LESSON_BOOK_VERSION &&
    typeof b.skill === 'string' &&
    b.skill.length > 0 &&
    typeof b.description === 'string' &&
    Array.isArray(b.augments) &&
    b.augments.every((a) => typeof a === 'string') &&
    Array.isArray(b.bullets) &&
    b.bullets.every(isLesson) &&
    Array.isArray(b.retired) &&
    b.retired.every(isLesson)
  );
}

/**
 * Move an unreadable book aside so the next turn starts clean.
 *
 * Deleting would destroy lessons a human might still want; throwing would let a
 * corrupt file fail every subsequent review. Renaming does neither.
 */
async function quarantine(bookPath: string): Promise<void> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  try {
    await rename(bookPath, `${bookPath}.corrupt-${stamp}`);
  } catch {
    // If even the rename fails there is nothing further to try; the caller
    // treats the book as absent either way.
  }
}

/**
 * Read a skill's lesson book. Returns null when the agent does not own the
 * skill, when there is no book yet, or when the book was unreadable (in which
 * case it is quarantined first). Never throws.
 */
export async function readBook(skillDir: string): Promise<LessonBook | null> {
  if (!(await isAgentOwned(skillDir))) return null;

  const bookPath = join(skillDir, LESSONS_FILENAME);
  let raw: string;
  try {
    raw = await readFile(bookPath, 'utf-8');
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    await quarantine(bookPath);
    return null;
  }

  if (!isBook(parsed)) {
    await quarantine(bookPath);
    return null;
  }

  return {
    ...parsed,
    retired: parsed.retired as RetiredLesson[],
  };
}

/**
 * Write a skill's lesson book. Throws `SkillOpError('plugin')` when the agent
 * does not own the directory.
 *
 * The write is atomic: a temp file in the same directory followed by a rename,
 * so a crash mid-write can never leave a half-parsed book behind.
 */
export async function writeBook(skillDir: string, book: LessonBook): Promise<void> {
  if (!(await isAgentOwned(skillDir))) {
    throw new SkillOpError(
      'plugin',
      `Skill "${basename(skillDir)}" is not agent-created; the agent does not own it and cannot record lessons against it.`,
    );
  }

  const bookPath = join(skillDir, LESSONS_FILENAME);
  const tempPath = `${bookPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(tempPath, `${JSON.stringify(book, null, 2)}\n`, 'utf-8');
    await rename(tempPath, bookPath);
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    throw error;
  }
}

/**
 * Write a lesson book and the `SKILL.md` rendered from it, creating the skill
 * directory when it does not exist yet.
 *
 * Creation goes through `createSkillInDir` rather than writing the files
 * directly, so a learned skill picks up the same `.source` marker and name
 * validation as any other agent-created skill — and so there is exactly one
 * place where a skill directory comes into being.
 */
export async function persistBook(managedDir: string, book: LessonBook): Promise<void> {
  const skillDir = join(managedDir, book.skill);

  if (existsSync(skillDir)) {
    // Ownership first, so a user-authored or plugin skill reports the real
    // reason rather than the weaker "already exists".
    if (!(await isAgentOwned(skillDir))) {
      throw new SkillOpError(
        'plugin',
        `Skill "${book.skill}" is not agent-created; the agent does not own it and cannot record lessons against it.`,
      );
    }

    // The `.source` = agent marker is NOT sufficient authority to overwrite:
    // `create_skill` writes it too, so a skill the user asked the agent to
    // author carries it while holding real instructions. Rendering a lesson
    // book over that destroys them.
    //
    // A directory may be written only when it already holds a lesson book, or
    // when its SKILL.md is one we generated. The second case matters because a
    // corrupt book gets quarantined (and so disappears) — without it, one bad
    // file would permanently block that skill from ever learning again.
    const hasBook = (await readBook(skillDir)) !== null;
    const generated = hasBook
      ? true
      : await readFile(join(skillDir, 'SKILL.md'), 'utf-8')
          .then((raw) => raw.includes(GENERATED_MARKER))
          .catch(() => false);

    if (!generated) {
      throw new SkillOpError(
        'duplicate',
        `Skill "${book.skill}" already exists and is not a lesson book; refusing to overwrite it. Record the lesson under a new skill that declares augments: [${book.skill}].`,
      );
    }
  } else {
    await createSkillInDir({
      managedDir,
      name: book.skill,
      description: book.description,
      content: renderSkillBody(book),
    });
  }

  await writeBook(skillDir, book);
  await writeFile(join(skillDir, 'SKILL.md'), renderSkillFile(book), 'utf-8');
}

/** Every lesson book under a managed skills directory, skill-name ordered. */
export async function listBooks(managedDir: string): Promise<LessonBook[]> {
  if (!existsSync(managedDir)) return [];

  let entries: string[];
  try {
    entries = (await readdir(managedDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }

  const books: LessonBook[] = [];
  for (const name of entries) {
    const book = await readBook(join(managedDir, name));
    if (book) books.push(book);
  }
  return books;
}
