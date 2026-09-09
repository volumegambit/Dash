import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MemoryStore } from './store.js';
import { MEMORY_LIMITS } from './types.js';

export const LEGACY_MEMORY_NAME = 'legacy-memory-md';
/**
 * Marker file written inside the store dir once the legacy import has run.
 * Not a `*.md` file, so `MemoryStore.list()` never surfaces it.
 */
export const LEGACY_IMPORT_MARKER = '.legacy-imported';
const TRUNCATED = '\n\n[truncated]';

/**
 * One-time import of the pre-memory-system `<workspace>/MEMORY.md` into the
 * store as a single `project` memory. The import is recorded with a marker file
 * in the store dir, so it never runs twice — a user who deletes the imported
 * memory keeps it deleted. An empty-store check remains as a secondary guard
 * for stores that already had memories before the marker existed. The legacy
 * workspace file is never modified or deleted.
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

  const markerPath = join(store.dir, LEGACY_IMPORT_MARKER);
  try {
    await stat(markerPath);
    return false; // already imported once — never again, even if the store is empty
  } catch {
    // no marker yet — fall through
  }
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
  await mkdir(store.dir, { recursive: true });
  await writeFile(markerPath, `${new Date().toISOString()}\n`, 'utf8');
  return true;
}
