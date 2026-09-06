import { renderSkillBody } from './render.js';
import { listBooks } from './store.js';

/**
 * Riding along with a skill the agent may not modify.
 *
 * Learning only ever writes to skills the agent owns, so a lesson about a
 * read-only plugin skill has to live somewhere else. Left at that, it would sit
 * in a book nobody thinks to open at the moment it matters. `augments` closes
 * that gap: a learned book names the skills it belongs beside, and its body is
 * appended when one of them is loaded.
 *
 * Lookup is deliberately one level deep — an augmenting book's own augments are
 * not followed. That makes a cycle impossible to recurse into, and keeps a
 * single `load_skill` call from pulling in a transitive pile of context.
 */

/** Rendered bodies of the agent-owned books that ride along with `skillName`. */
export async function collectAugments(managedDir: string, skillName: string): Promise<string[]> {
  const books = await listBooks(managedDir);

  return books
    .filter(
      (book) =>
        book.skill !== skillName && book.bullets.length > 0 && book.augments.includes(skillName),
    )
    .map((book) => renderSkillBody(book));
}

/**
 * Append ride-along bodies to a loaded skill's content.
 *
 * The appended section is labelled so its provenance is legible: the authored
 * skill is instruction, the learned lessons are observations from past sessions
 * that may be wrong. A reader — human or model — should be able to tell which
 * is which without checking the filesystem.
 */
export function appendAugments(content: string, bodies: string[]): string {
  if (bodies.length === 0) return content;

  return [
    content,
    '',
    '---',
    '',
    '## Learned from previous sessions',
    '',
    'The following was recorded automatically while working on this kind of task.',
    'It is experience, not instruction — prefer the skill above where they disagree.',
    '',
    ...bodies,
  ].join('\n');
}
