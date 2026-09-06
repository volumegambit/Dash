import { flattenOneLine } from './render.js';
import { LESSON_LIMITS, type LessonBook } from './types.js';

/**
 * The review prompt.
 *
 * This is the part of skill learning that decides whether the feature is worth
 * having, so the reasoning behind each section is recorded here rather than in
 * a design document nobody opens.
 *
 * It has to push against two opposite failure modes at once:
 *
 * - **Silence.** A model asked to reflect on a session will, by default,
 *   conclude that nothing notable happened. A review that always returns
 *   nothing makes the whole feature inert while still costing a call.
 * - **Superstition.** A model asked to record everything will write down
 *   whatever went wrong today, including things that were never true in
 *   general. Those entries do not stay inert — they are replayed into context
 *   for months and the agent cites them against itself long after the
 *   underlying problem is gone.
 *
 * The output contract is JSON rather than prose because the merge that consumes
 * it is deterministic: nothing downstream re-reads the library or re-decides
 * anything, which is what keeps the review to a single call.
 */

export interface ReviewPromptInput {
  books: LessonBook[];
  /** Skills the agent loaded during the turn under review. */
  loadedSkills: string[];
}

/**
 * The catalogue of lessons already held, as the reviewer sees it.
 *
 * Retired lessons are deliberately absent. Showing them would invite the
 * reviewer to re-propose something that already failed — and the merge would
 * drop it, spending a delta to achieve nothing.
 */
export function renderLessonIndex(books: LessonBook[]): string {
  const withLessons = books.filter((b) => b.bullets.length > 0);
  if (withLessons.length === 0) {
    return 'No lessons have been learned yet. The library is empty.';
  }

  const lines: string[] = [];
  for (const book of withLessons) {
    lines.push(`### ${book.skill} — ${flattenOneLine(book.description, 120)}`);
    for (const bullet of book.bullets) {
      lines.push(`- [${bullet.id}] ${flattenOneLine(bullet.text)}`);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

export function buildReviewPrompt(input: ReviewPromptInput): string {
  const loaded =
    input.loadedSkills.length > 0
      ? input.loadedSkills.map((s) => flattenOneLine(s, 64)).join(', ')
      : '(none)';

  return `You are reviewing a finished working session to decide what, if anything, should be
remembered as a reusable lesson for next time.

## Lessons already held

${renderLessonIndex(input.books)}

Skills loaded during this session: ${loaded}

## What you are deciding

Return a list of deltas. There are exactly three operations:

- "add" — a new lesson worth keeping. Give "skill" (the lesson book it belongs
  to) and "text" (the lesson, one sentence, imperative, self-contained). If the
  book does not exist yet, also give "description" (when a future session should
  consult it) and optionally "augments" (existing skill names this rides along
  with).
- "helpful" — a lesson listed above was in play this session and proved right.
  Give "skill" and "id".
- "harmful" — a lesson listed above was in play and proved wrong, outdated or
  misleading. Give "skill", "id" and a short "reason". A lesson marked harmful
  ${LESSON_LIMITS.harmfulRetireThreshold} times without ever being helpful retires itself, so this is how
  bad advice gets removed.

## Prefer the smallest action that fits

1. Add the lesson to a book that already covers this class of work.
2. Mark an existing lesson helpful or harmful if this session tested it.
3. Only create a new book when nothing above fits.

A new book is the expensive option: it costs a slot, and a library of many
narrow books is worse than a few good ones. Name a book for the **class of
task**, never for today's instance. A name that only makes sense for today —
containing a ticket number, an error string, a date, or a one-off feature name —
is wrong. If that is the only name that fits, add the lesson to an existing book
instead.

## Do not record these

These look like lessons and are not. Each one becomes a standing constraint that
outlives the situation that produced it.

1. **Environment-dependent failures** — a missing binary, an unset credential, a
   path that only breaks on this machine, a package that is not installed. These
   get fixed. They are not durable rules.
2. **A tool or feature being broken or unusable.** Never record "X does not
   work" or "cannot use Y". Claims like this harden into refusals that get cited
   for months after the cause was fixed. If something failed because of setup,
   the lesson is the *fix* — the command, the config, the setting — never the
   incapacity.
3. **Transient errors that resolved.** If a retry worked, the lesson is the
   retry, not the original error.
4. **One-off task narratives.** Doing a specific piece of work is not a class of
   work. Summarising one document does not warrant a lesson.
5. **Anything sensitive** — credentials, tokens, keys, personal data. Lessons
   are written to disk and replayed into future sessions.

## Returning nothing

"No lessons" is a real answer, but it is not a safe default. A session that
involved real work usually produced at least one thing worth keeping — a
technique, a correction the user made, a dead end worth not repeating, or
confirmation that a lesson already held was right. Returning an empty list means
you looked and found nothing, and you should be able to justify that. A session
that ran smoothly and taught nothing new is the case where empty is correct.

## Output

Respond with JSON only, no prose around it:

{"deltas": [{"op": "add", "skill": "...", "text": "...", "description": "..."}]}

Return {"deltas": []} if there is genuinely nothing to record. Keep each lesson
under ${LESSON_LIMITS.maxLessonChars} characters.`;
}
