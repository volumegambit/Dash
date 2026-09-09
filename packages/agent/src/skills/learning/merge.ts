import { createHash } from 'node:crypto';
import { isValidSkillName } from '../validate.js';
import {
  LESSON_LIMITS,
  type Lesson,
  type LessonBook,
  type LessonDelta,
  type RetiredLesson,
} from './types.js';

/**
 * The deterministic half of skill learning.
 *
 * A review pass proposes deltas; nothing here asks a model anything. Keeping
 * the merge pure is what makes the loop auditable: every retirement and every
 * dropped delta is the result of a rule you can read, and the whole thing is
 * testable without a network.
 */

export interface MergeOptions {
  today?: string;
  limits?: typeof LESSON_LIMITS;
  /**
   * Names of skills that already exist for this agent — plugin, installed, user
   * -authored, or agent-authored via `create_skill`.
   *
   * An `add` naming one of these (that has no lesson book) is dropped. Writing a
   * book onto such a skill would render lessons over instructions somebody
   * meant to keep, and creating a managed skill of the same name would shadow a
   * plugin skill in discovery. The review is told to use `augments` instead.
   */
  reservedNames?: string[];
}

export interface DroppedDelta {
  delta: LessonDelta;
  reason: string;
}

export interface BookMergeResult {
  book: LessonBook;
  applied: number;
  dropped: DroppedDelta[];
}

export interface MergeResult {
  /** Only the books that actually changed. */
  books: LessonBook[];
  /** Names of books created by this merge. */
  created: string[];
  applied: number;
  dropped: DroppedDelta[];
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Collapse a lesson to its comparable form: lowercase, punctuation removed,
 * whitespace squeezed.
 *
 * This is what makes a restatement of an existing lesson count as agreement
 * rather than as a second copy. It catches verbatim and near-verbatim repeats
 * and will miss paraphrases — a deliberate floor, not a ceiling. Semantic
 * matching is a later upgrade and would make this function impure.
 */
export function normaliseLessonText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** A stable id for a lesson, derived from its normalised text. */
export function lessonId(text: string): string {
  return createHash('sha256').update(normaliseLessonText(text)).digest('hex').slice(0, 6);
}

function retire(lesson: Lesson, reason: RetiredLesson['retiredReason'], at: string): RetiredLesson {
  return { ...lesson, retiredAt: at, retiredReason: reason };
}

/**
 * Choose the lesson to evict when a book is over capacity.
 *
 * Lessons touched during this merge are protected: without that, a book full of
 * well-scored lessons would evict every new lesson the moment it arrived and
 * the agent would silently stop learning about that topic forever. If every
 * lesson was touched this turn, the protection is dropped so the cap still
 * holds.
 */
function weakest(bullets: Lesson[], today: string): Lesson {
  const candidates = bullets.filter((b) => b.lastTouchedAt !== today);
  const pool = candidates.length > 0 ? candidates : bullets;

  return pool.reduce((worst, b) => {
    const score = b.helpful - b.harmful;
    const worstScore = worst.helpful - worst.harmful;
    if (score !== worstScore) return score < worstScore ? b : worst;
    return b.lastTouchedAt < worst.lastTouchedAt ? b : worst;
  });
}

/**
 * Apply an ordered list of deltas to one lesson book. Pure — the input book is
 * never mutated.
 */
export function applyDeltasToBook(
  input: LessonBook,
  deltas: LessonDelta[],
  options: MergeOptions = {},
): BookMergeResult {
  const today = options.today ?? todayIso();
  const limits = options.limits ?? LESSON_LIMITS;
  const book = structuredClone(input);
  const dropped: DroppedDelta[] = [];
  let applied = 0;

  for (const delta of deltas) {
    if (delta.op === 'add') {
      const key = normaliseLessonText(delta.text);

      // Rule 9: a lesson that already retired does not come back. Without this
      // a harmful lesson can be re-proposed forever, retiring and returning on
      // a loop.
      if (book.retired.some((r) => normaliseLessonText(r.text) === key)) {
        dropped.push({ delta, reason: 'matches a lesson that was already retired' });
        continue;
      }

      // Rule 2: a restatement is agreement with the lesson already held.
      const existing = book.bullets.find((b) => normaliseLessonText(b.text) === key);
      if (existing) {
        existing.helpful += 1;
        existing.lastTouchedAt = today;
        applied += 1;
        continue;
      }

      // Rule 3.
      book.bullets.push({
        id: lessonId(delta.text),
        text: delta.text,
        helpful: 0,
        harmful: 0,
        createdAt: today,
        lastTouchedAt: today,
      });
      applied += 1;
      continue;
    }

    // Rule 4.
    const target = book.bullets.find((b) => b.id === delta.id);
    if (!target) {
      dropped.push({ delta, reason: `unknown lesson id "${delta.id}"` });
      continue;
    }

    if (delta.op === 'helpful') target.helpful += 1;
    else target.harmful += 1;
    target.lastTouchedAt = today;
    applied += 1;

    // Rule 5: only ever harmful, never helpful — retire it.
    if (target.harmful >= limits.harmfulRetireThreshold && target.helpful === 0) {
      book.bullets = book.bullets.filter((b) => b.id !== target.id);
      book.retired.push(retire(target, 'harmful', today));
    }
  }

  // Rule 6: cap the book.
  while (book.bullets.length > limits.maxLessonsPerSkill) {
    const evicted = weakest(book.bullets, today);
    book.bullets = book.bullets.filter((b) => b.id !== evicted.id);
    book.retired.push(retire(evicted, 'capacity', today));
  }

  return { book, applied, dropped };
}

/** Reject deltas that must never reach the filesystem or a book. */
function prevalidate(
  deltas: LessonDelta[],
  limits: typeof LESSON_LIMITS,
): { kept: LessonDelta[]; dropped: DroppedDelta[] } {
  const kept: LessonDelta[] = [];
  const dropped: DroppedDelta[] = [];

  for (const delta of deltas) {
    if (!isValidSkillName(delta.skill)) {
      dropped.push({ delta, reason: `invalid skill name "${delta.skill}"` });
      continue;
    }
    if (delta.op === 'add') {
      const text = delta.text.trim();
      if (text.length === 0) {
        dropped.push({ delta, reason: 'empty lesson' });
        continue;
      }
      if (text.length > limits.maxLessonChars) {
        dropped.push({
          delta,
          reason: `lesson is too long (${text.length} > ${limits.maxLessonChars} characters)`,
        });
        continue;
      }
    }
    kept.push(delta);
  }

  return { kept, dropped };
}

/**
 * Merge a review pass's deltas into an agent's lesson books.
 *
 * Returns only the books that changed, so the caller writes the minimum. Books
 * are created on demand by an `add` naming a skill that has none — subject to
 * the per-agent skill cap, which drops the delta rather than evicting an
 * existing book, because evicting a whole skill is far more destructive than
 * declining to learn one more.
 */
export function mergeDeltas(
  books: LessonBook[],
  deltas: LessonDelta[],
  options: MergeOptions = {},
): MergeResult {
  const today = options.today ?? todayIso();
  const limits = options.limits ?? LESSON_LIMITS;
  const { kept, dropped } = prevalidate(deltas, limits);

  const bySkill = new Map(books.map((b) => [b.skill, b]));
  const grouped = new Map<string, LessonDelta[]>();
  for (const delta of kept) {
    const list = grouped.get(delta.skill);
    if (list) list.push(delta);
    else grouped.set(delta.skill, [delta]);
  }

  const changed: LessonBook[] = [];
  const created: string[] = [];
  let applied = 0;
  let skillCount = books.length;

  const reserved = new Set(options.reservedNames ?? []);

  for (const [skill, skillDeltas] of grouped) {
    let book = bySkill.get(skill);

    if (!book && reserved.has(skill)) {
      for (const delta of skillDeltas) {
        dropped.push({
          delta,
          reason: `"${skill}" names an existing skill that is not a lesson book; record this under a new skill declaring augments: [${skill}]`,
        });
      }
      continue;
    }

    if (!book) {
      const seed = skillDeltas.find((d) => d.op === 'add');
      if (!seed || seed.op !== 'add') {
        for (const delta of skillDeltas) {
          dropped.push({ delta, reason: `no lesson book for "${skill}"` });
        }
        continue;
      }
      if (skillCount >= limits.maxSkills) {
        for (const delta of skillDeltas) {
          dropped.push({
            delta,
            reason: `learned-skill limit reached (${limits.maxSkills}); not creating "${skill}"`,
          });
        }
        continue;
      }
      book = {
        version: 1,
        skill,
        description: seed.description?.trim() || `Lessons learned while working on ${skill}`,
        augments: seed.augments ?? [],
        bullets: [],
        retired: [],
      };
      created.push(skill);
      skillCount += 1;
    }

    const result = applyDeltasToBook(book, skillDeltas, { today, limits });
    dropped.push(...result.dropped);
    applied += result.applied;

    if (result.applied > 0) changed.push(result.book);
    else if (created.at(-1) === skill) created.pop();
  }

  return { books: changed, created, applied, dropped };
}
