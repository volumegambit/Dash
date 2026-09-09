/**
 * Types for automatic skill learning.
 *
 * A learned skill is an ordinary skill directory that additionally carries a
 * `lessons.json` "lesson book". The book is the machine source of truth; the
 * `SKILL.md` beside it is rendered from the book on every write so the agent
 * and the user read the same thing.
 *
 * Updates are itemised deltas rather than whole-document rewrites. Rewriting a
 * document on each pass erodes detail: every pass re-summarises what came
 * before, so specifics that took several sessions to accumulate get compressed
 * away. Appending or annotating one bullet leaves every other bullet untouched.
 * See "Agentic Context Engineering" (arXiv 2510.04618) for the same result
 * measured on benchmarks.
 */

/** One learned lesson. `id` is stable and derived from the lesson's normalised text. */
export interface Lesson {
  id: string;
  text: string;
  /** Times a review pass judged this lesson to have helped. */
  helpful: number;
  /** Times a review pass judged this lesson wrong or misleading. */
  harmful: number;
  createdAt: string;
  lastTouchedAt: string;
}

/** Why a lesson left the active list. Retirement moves a lesson; it never deletes one. */
export type RetireReason = 'harmful' | 'capacity';

export interface RetiredLesson extends Lesson {
  retiredAt: string;
  retiredReason: RetireReason;
}

/** The `lessons.json` document for one agent-owned skill. */
export interface LessonBook {
  version: 1;
  skill: string;
  description: string;
  /**
   * Names of skills this book rides along with. When one of them is loaded,
   * this book's body is appended to the same result — which is how a lesson
   * about a read-only plugin skill still reaches the agent.
   */
  augments: string[];
  bullets: Lesson[];
  retired: RetiredLesson[];
}

/**
 * The only three operations a review pass may return.
 *
 * Deliberately minimal: there is no "edit" or "delete". A lesson that turns out
 * to be wrong is marked `harmful` and retires itself once the counter passes
 * the threshold, which leaves an audit trail that an in-place edit would erase.
 */
export type LessonDelta =
  | { op: 'add'; skill: string; text: string; description?: string; augments?: string[] }
  | { op: 'helpful'; skill: string; id: string }
  | { op: 'harmful'; skill: string; id: string; reason?: string };

export const LESSON_LIMITS = {
  /** Learned skills per agent. An `add` naming a further new skill is dropped. */
  maxSkills: 30,
  /** Active lessons per book. Overflow retires the least valuable lesson. */
  maxLessonsPerSkill: 50,
  /** Longest a single lesson may be, after escaping. */
  maxLessonChars: 500,
  /** `harmful` count at which a never-helpful lesson retires. */
  harmfulRetireThreshold: 3,
} as const;

export const LESSONS_FILENAME = 'lessons.json';

/**
 * Marker file that makes a skill agent-owned. Already written by
 * `createSkillInDir` and read by `scanSkillsDirectory`; this feature makes it
 * the enforcement point for "learning never writes to a skill it does not own".
 */
export const SOURCE_FILENAME = '.source';
export const AGENT_SOURCE = 'agent';

export const LESSON_BOOK_VERSION = 1;

export function isLessonDelta(value: unknown): value is LessonDelta {
  if (typeof value !== 'object' || value === null) return false;
  const d = value as Record<string, unknown>;
  if (typeof d.skill !== 'string' || d.skill.length === 0) return false;
  if (d.op === 'add') return typeof d.text === 'string' && d.text.trim().length > 0;
  if (d.op === 'helpful' || d.op === 'harmful') {
    return typeof d.id === 'string' && d.id.length > 0;
  }
  return false;
}
