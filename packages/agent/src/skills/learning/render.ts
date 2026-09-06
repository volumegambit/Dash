import { generateFrontmatter } from '../frontmatter.js';
import type { SkillFrontmatter } from '../types.js';
import { LESSON_LIMITS, type LessonBook } from './types.js';

/**
 * Rendering a lesson book to its `SKILL.md`.
 *
 * Everything here treats lesson text as untrusted. A lesson is written by a
 * model that has just read arbitrary user messages, file contents and web
 * pages, and the result is persisted and then replayed into context on later
 * turns — so a single unescaped lesson would be a durable injection, not a
 * one-turn one.
 *
 * Two concrete breakouts are defended against, both reachable today:
 *
 * 1. `generateFrontmatter` interpolates `description` raw, so a newline in a
 *    description injects arbitrary frontmatter keys (`tools:`, `allowed-tools:`)
 *    and a `---` line closes the block early.
 * 2. A code fence inside a lesson opens a block that swallows every following
 *    lesson, hiding them from the reader while leaving them in the file.
 */

/**
 * Reduce untrusted text to a single harmless line.
 *
 * Order matters: neutralise the structural sequences first, then collapse
 * whitespace, then cap. Capping first could truncate mid-escape.
 */
export function flattenOneLine(text: string, max: number = LESSON_LIMITS.maxLessonChars): string {
  const neutralised = text
    // Code fences would swallow following content.
    .replace(/`{3,}/g, "'''")
    // A run of three or more dashes can close a frontmatter block.
    .replace(/-{3,}/g, '--')
    // Comment openers can hide content from a reader while keeping it in file.
    .replace(/<!--/g, '&lt;!--')
    .replace(/-->/g, '--&gt;');

  const collapsed = neutralised.replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1).trimEnd()}…` : collapsed;
}

/**
 * Footer stamped on every generated body. It is also the marker that makes a
 * generated `SKILL.md` recognisable: `persistBook` will only overwrite a file
 * that carries it, which is what stops a lesson book from being rendered over a
 * skill somebody actually wrote.
 */
export const GENERATED_MARKER =
  'This file is generated from `lessons.json`; edits here are replaced on the next update.';

/** The markdown body of a learned skill: one list item per active lesson. */
export function renderSkillBody(book: LessonBook): string {
  const lines: string[] = [];

  lines.push('These lessons were learned automatically from previous sessions.');
  lines.push('');

  if (book.augments.length > 0) {
    // Wrapped rather than passed by reference: `map` would supply the element
    // index as the `max` argument and truncate every entry to nothing.
    const names = book.augments.map((name) => flattenOneLine(name)).join(', ');
    lines.push(`Applies alongside: ${names}.`);
    lines.push('');
  }

  if (book.bullets.length === 0) {
    lines.push('No lessons are currently held for this skill.');
  } else {
    lines.push('## Lessons');
    lines.push('');
    for (const bullet of book.bullets) {
      lines.push(`- ${flattenOneLine(bullet.text)}`);
    }
  }

  lines.push('');
  lines.push(GENERATED_MARKER);

  return `${lines.join('\n')}\n`;
}

/** The complete `SKILL.md` for a learned skill. */
export function renderSkillFile(book: LessonBook): string {
  const frontmatter: SkillFrontmatter = {
    name: book.skill,
    // Flattened because generateFrontmatter interpolates this value raw.
    description: flattenOneLine(book.description, 200),
  };

  return generateFrontmatter(frontmatter, renderSkillBody(book));
}
