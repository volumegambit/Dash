import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MemoryStore } from './store.js';
import { MEMORY_LIMITS } from './types.js';

export const LEGACY_MEMORY_NAME = 'legacy-memory-md';
const TRUNCATED = '\n\n[truncated]';

/**
 * One-time import of the pre-memory-system `<workspace>/MEMORY.md` into the
 * store as a single `project` memory. Runs only when the store is empty, so
 * the presence of any memory (including a previous import) stops it. The
 * legacy file is never modified.
 */
export async function importLegacyMemoryFile(
  store: MemoryStore,
  workspace: string | undefined,
): Promise<boolean> {
  if (!workspace) return false;
  let raw: string;
  try {
    raw = await readFile(join(workspace, 'MEMORY.md'), 'utf8');
  } catch {
    return false;
  }
  if (!raw.trim()) return false;
  if ((await store.count()) > 0) return false;

  let content = raw.trim();
  const max = MEMORY_LIMITS.importContentMax;
  if (content.length > max) content = `${content.slice(0, max - TRUNCATED.length)}${TRUNCATED}`;

  await store.save({
    name: LEGACY_MEMORY_NAME,
    description: 'Notes imported from the old workspace MEMORY.md file',
    type: 'project',
    content,
    source: 'import',
  });
  return true;
}
