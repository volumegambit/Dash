import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Absolute path to the bundled skills directory.
 *
 * The `skills/` directory lives at the package root (sibling of `src/` and
 * `dist/`), so resolving one level up from this module's directory works
 * whether running from source (`src/index.ts`) or built output (`dist/index.js`).
 */
export function getBundledSkillsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'skills');
}

/** The suites the bundled library is organized into. */
export const BUNDLED_SUITES = ['assistant', 'dev', 'creative', 'comms', 'meta'] as const;

export type BundledSuite = (typeof BUNDLED_SUITES)[number];
