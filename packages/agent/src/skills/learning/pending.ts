import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isLessonDelta } from './types.js';
import type { LessonDelta } from './types.js';

/**
 * Staging for the optional human-approval gate.
 *
 * What is staged is the *deltas*, not the merged books. Approval can come
 * minutes or days after the review that proposed it, by which time the books
 * may have moved on — a lesson may have been marked harmful, or an identical
 * one added. Re-merging the deltas at approval time keeps every rule (dedup,
 * retirement, the caps) applying to the library as it actually is, rather than
 * baking in a decision made against a stale snapshot.
 *
 * The directory sits inside the managed skills directory but cannot be mistaken
 * for a skill: discovery only accepts a subdirectory containing a `SKILL.md`.
 */

export const PENDING_DIRNAME = '.pending-lessons';

export interface PendingLessons {
  id: string;
  createdAt: string;
  conversationId: string;
  deltas: LessonDelta[];
}

function pendingDir(managedDir: string): string {
  return join(managedDir, PENDING_DIRNAME);
}

/** Reject anything that could escape the pending directory. */
function isSafeId(id: string): boolean {
  return /^[a-z0-9-]{1,64}$/i.test(id);
}

/** Stage a review's proposal for human approval. Returns the staged id. */
export async function stagePending(
  managedDir: string,
  entry: Omit<PendingLessons, 'createdAt'> & { createdAt?: string },
): Promise<string> {
  if (!isSafeId(entry.id)) throw new Error(`Invalid pending id "${entry.id}"`);

  const dir = pendingDir(managedDir);
  await mkdir(dir, { recursive: true });

  const record: PendingLessons = {
    id: entry.id,
    createdAt: entry.createdAt ?? new Date().toISOString(),
    conversationId: entry.conversationId,
    deltas: entry.deltas,
  };

  const target = join(dir, `${entry.id}.json`);
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, 'utf-8');
  await rename(temp, target);

  return entry.id;
}

/** Every staged proposal, oldest first. Unreadable entries are skipped. */
export async function listPending(managedDir: string): Promise<PendingLessons[]> {
  const dir = pendingDir(managedDir);
  if (!existsSync(dir)) return [];

  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith('.json')).sort();
  } catch {
    return [];
  }

  const out: PendingLessons[] = [];
  for (const name of names) {
    const record = await readPending(managedDir, name.replace(/\.json$/, ''));
    if (record) out.push(record);
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** One staged proposal, or null when it is absent or unreadable. */
export async function readPending(managedDir: string, id: string): Promise<PendingLessons | null> {
  if (!isSafeId(id)) return null;

  try {
    const raw = await readFile(join(pendingDir(managedDir), `${id}.json`), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<PendingLessons>;
    if (typeof parsed.id !== 'string' || !Array.isArray(parsed.deltas)) return null;
    return {
      id: parsed.id,
      createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : '',
      conversationId: typeof parsed.conversationId === 'string' ? parsed.conversationId : '',
      deltas: parsed.deltas.filter(isLessonDelta),
    };
  } catch {
    return null;
  }
}

/** Remove a staged proposal. Returns whether anything was removed. */
export async function removePending(managedDir: string, id: string): Promise<boolean> {
  if (!isSafeId(id)) return false;

  const target = join(pendingDir(managedDir), `${id}.json`);
  if (!existsSync(target)) return false;
  await rm(target, { force: true });
  return true;
}
