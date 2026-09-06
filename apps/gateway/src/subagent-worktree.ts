import { execFile } from 'node:child_process';
import { mkdir, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

/**
 * `execFile`, never `exec`: the worktree path is built from an agent NAME and a
 * child id, neither of which is ours to trust as shell input. With execFile no
 * argument is shell-interpreted.
 */
const run = promisify(execFile);

/** The spawn-time refusal for `isolation: worktree` on a non-git workspace. */
export const WORKTREE_REQUIRES_GIT = 'isolation: worktree requires a git workspace';

/**
 * Where one isolated child's worktree lives:
 * `<dataDir>/worktrees/<agentName>/<childId>`. Deterministic from the spec, so
 * the finish-time cleanup can find it again without carrying state from spawn.
 */
export function childWorktreePath(o: {
  dataDir: string;
  agentName: string;
  childId: string;
}): string {
  return resolve(o.dataDir, 'worktrees', o.agentName, o.childId);
}

/** True when `workspace` is inside a git working tree. */
async function isGitWorkspace(workspace: string): Promise<boolean> {
  try {
    const { stdout } = await run('git', ['-C', workspace, 'rev-parse', '--is-inside-work-tree']);
    return stdout.trim() === 'true';
  } catch {
    // Not a repo, or the directory does not exist — either way there is no
    // working tree to branch a child off.
    return false;
  }
}

/**
 * Give one child its own checkout of the parent's workspace.
 *
 * The branch point is the workspace's CURRENT HEAD, not the repository's
 * default branch (design Platform Adaptation 5). A Dash workspace is routinely
 * parked on a feature branch, and may have no remote at all; a child that
 * checked out `main` would be reading files the user is not looking at. The
 * checkout is `--detach`ed so the child never occupies — or moves — the
 * parent's branch, which matters because parent and child are live at the same
 * time.
 *
 * Throws the exact `WORKTREE_REQUIRES_GIT` message when the workspace is not a
 * git working tree: isolation cannot be honoured, and silently sharing the
 * parent's directory instead would be the opposite of what was asked for.
 */
export async function createChildWorktree(o: {
  workspace: string;
  dataDir: string;
  agentName: string;
  childId: string;
}): Promise<{ path: string }> {
  if (!(await isGitWorkspace(o.workspace))) throw new Error(WORKTREE_REQUIRES_GIT);
  const path = childWorktreePath(o);
  await mkdir(dirname(path), { recursive: true });
  await run('git', ['-C', o.workspace, 'worktree', 'add', '--detach', path, 'HEAD']);
  return { path };
}

/**
 * The worktree an isolated child runs in, creating it only when it has none.
 *
 * A RESUME reaches this in both states and neither is exceptional:
 * - the worktree is STILL THERE — a `max_turns` child's is kept on purpose,
 *   because its `[partial: … resumable with send_message]` report points at
 *   the work in it. `git worktree add` refuses an existing path, so a resume
 *   that always created would fail exactly the child that invites resumption.
 * - the worktree is GONE — every other terminal status removed it, so the
 *   resume needs a fresh checkout of the workspace's current HEAD.
 *
 * A path that exists but is NOT a git working tree is left to
 * {@link createChildWorktree} to fail on: silently reusing a directory that
 * is not a checkout would run the child somewhere with no relation to the
 * workspace it was told to work in.
 */
export async function ensureChildWorktree(o: {
  workspace: string;
  dataDir: string;
  agentName: string;
  childId: string;
}): Promise<{ path: string; reused: boolean }> {
  const path = childWorktreePath(o);
  if (await isGitWorkspace(path)) return { path, reused: true };
  return { path: (await createChildWorktree(o)).path, reused: false };
}

/**
 * The ONLY ignored content a worktree removal is allowed to destroy.
 *
 * `git status --porcelain` omits gitignored files entirely, so a worktree whose
 * sole content is ignored reads CLEAN and `git worktree remove` deletes it
 * recursively. That is not a corner case here: this repo gitignores
 * `docs/plans/`, `PLAN.md`, `.superpowers/brainstorm/`, `data/`, `config/`,
 * `.env` and `CLAUDE.md`/`AGENTS.md`, and its own CLAUDE.md instructs every
 * agent to write plans into `docs/plans/`. So cleanup asks git for the ignored
 * entries too and subtracts exactly this set — build output and editor litter,
 * regenerable by definition. ANYTHING else keeps the worktree.
 *
 * Entries ending in `/` name a directory; `*.ext` is a suffix glob; the rest
 * are exact file names. All three are matched against the LAST path segment,
 * which is what `--ignored=matching` reports (an ignored directory is reported
 * as the directory, not its contents).
 *
 * Deliberately short and deliberately exported: widening it widens what a
 * finished child can silently lose, so it should be reviewed as policy.
 */
export const DISPOSABLE_WORKTREE_ARTEFACTS = [
  'node_modules/',
  'dist/',
  'build/',
  '.next/',
  'coverage/',
  '*.log',
  '.DS_Store',
] as const;

/** True when a status path is regenerable build output or editor litter. */
export function isDisposableArtefact(path: string): boolean {
  const segments = path.replace(/\/+$/, '').split('/');
  const name = segments[segments.length - 1];
  if (!name) return false;
  return DISPOSABLE_WORKTREE_ARTEFACTS.some((pattern) => {
    if (pattern.endsWith('/')) return name === pattern.slice(0, -1);
    if (pattern.startsWith('*.')) return name.endsWith(pattern.slice(1));
    return name === pattern;
  });
}

/** One `git status --porcelain -z` record. */
interface StatusEntry {
  /** The two-letter status code; `!!` for ignored, `??` for untracked. */
  code: string;
  path: string;
}

/**
 * Parse `git status --porcelain -z`. `-z` (not the plain form) because paths
 * with spaces or non-ASCII bytes come back C-quoted otherwise, and a misparsed
 * path here decides whether a directory gets deleted.
 *
 * A rename/copy record is followed by a SECOND NUL-terminated field holding the
 * original path; it is consumed rather than parsed as a record of its own.
 */
function parseStatus(stdout: string): StatusEntry[] {
  const fields = stdout.split('\0');
  const entries: StatusEntry[] = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (!field) continue;
    const code = field.slice(0, 2);
    entries.push({ code, path: field.slice(3) });
    // `R`/`C` in either column ⇒ the next field is the source path.
    if (code.includes('R') || code.includes('C')) i++;
  }
  return entries;
}

/** What one cleanup attempt found, and what it did about it. */
export interface WorktreeCleanupResult {
  /** True only when the worktree was taken down. */
  removed: boolean;
  /**
   * Everything that stopped the removal: tracked modifications, staged changes,
   * untracked files AND ignored content that is not on the disposable list.
   * Empty when `removed` is true.
   */
  blocking: string[];
  /** Ignored-but-disposable entries the removal destroyed, or would have. */
  disposable: string[];
}

/**
 * Take an isolated child's worktree down — but only if it is EMPTY-HANDED.
 *
 * `--ignored=matching` is load-bearing: without it `git status --porcelain`
 * reports a worktree holding nothing but a gitignored deliverable as clean, and
 * the removal below deletes it recursively with no warning. See
 * `DISPOSABLE_WORKTREE_ARTEFACTS` for the only content that does not count.
 *
 * Anything the child produced and did not commit therefore keeps the directory
 * alive — the caller surfaces the kept path and the reason instead. Destroying
 * a child's output is the one unrecoverable thing this code can do, so every
 * ambiguous case resolves to KEEP.
 */
export async function cleanupChildWorktree(o: {
  workspace: string;
  path: string;
}): Promise<WorktreeCleanupResult> {
  const { stdout } = await run('git', [
    '-C',
    o.path,
    'status',
    '--porcelain',
    '-z',
    '--ignored=matching',
  ]);
  const blocking: string[] = [];
  const disposable: string[] = [];
  for (const entry of parseStatus(stdout)) {
    if (entry.code === '!!' && isDisposableArtefact(entry.path)) disposable.push(entry.path);
    else blocking.push(entry.path);
  }
  if (blocking.length > 0) return { removed: false, blocking, disposable };
  // Deliberately NOT `--force`: git re-checks the tree itself, so if the child
  // wrote something between our status call and this line the removal fails
  // loudly instead of deleting it. That last-moment refusal is a feature.
  await run('git', ['-C', o.workspace, 'worktree', 'remove', o.path]);
  return { removed: true, blocking, disposable };
}

/** What one boot sweep found, and what it did about it. */
export interface OrphanWorktreeSweepResult {
  /** Directories under `<dataDir>/worktrees/<agent>/` that were considered. */
  scanned: number;
  /** Worktrees taken down, absolute paths. */
  removed: string[];
  /** Worktrees left in place, with the reason each survived. */
  kept: Array<{ path: string; reason: string }>;
  /** Repositories a `git worktree prune` was run in. */
  prunedRepos: string[];
}

/**
 * The repository a linked worktree belongs to, or `undefined` when the path is
 * not a linked worktree at all.
 *
 * `--git-common-dir` is the SHARED `.git` of the whole worktree set, so its
 * parent is the main working tree — which is where `git worktree remove` and
 * `git worktree prune` have to run. Resolving it from the worktree itself is
 * what lets the sweep work with no state carried over from the spawn: the
 * gateway that created these directories is dead.
 */
async function repoOf(path: string): Promise<string | undefined> {
  try {
    const { stdout } = await run('git', [
      '-C',
      path,
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    ]);
    const commonDir = stdout.trim();
    if (!commonDir) return undefined;
    return dirname(commonDir);
  } catch {
    return undefined;
  }
}

/** Terminal child statuses whose worktree is still wanted. */
const KEEP_STATUSES = new Set(['running', 'waiting_input', 'max_turns']);

/**
 * BOOT SWEEP for worktrees a previous gateway process leaked (Task B6's open
 * leak, closed here in C6).
 *
 * The finish-time hook (`cleanupWorktreeForSpec`) only runs when a child
 * reaches a terminal state IN THIS PROCESS. A SIGKILL between spawn and finish
 * therefore leaves two things behind that nothing else ever sweeps: the
 * directory itself, and a registration in the parent repo that `git worktree
 * list` reports as `prunable` once the directory is gone. Both accumulate for
 * ever.
 *
 * No child is live at boot, so every directory under `<dataDir>/worktrees` is
 * by definition an orphan — but "orphan" is not "disposable". This applies
 * exactly the B6 rule, via the same {@link cleanupChildWorktree}: a worktree
 * with uncommitted work, untracked files, or ignored content that is not on
 * {@link DISPOSABLE_WORKTREE_ARTEFACTS} is KEPT. So is a `max_turns` child's
 * (its `[partial: …]` report points at the work inside it) and, when a caller
 * passes `isLive`, so is a running child's.
 *
 * Every ambiguous case resolves to KEEP: a path that is not a git worktree at
 * all has no repository to remove it from, and deleting it blind is the one
 * unrecoverable thing this code could do.
 *
 * Fully contained per directory — a boot sweep may never break boot.
 */
export async function reapOrphanWorktrees(o: {
  dataDir: string;
  /** True while this process still holds a handle for the child. */
  isLive?: (childId: string) => boolean;
  /** The child's persisted sub-agent status, when its row still exists. */
  statusOf?: (childId: string) => string | undefined;
  log?: (message: string) => void;
}): Promise<OrphanWorktreeSweepResult> {
  const root = resolve(o.dataDir, 'worktrees');
  const result: OrphanWorktreeSweepResult = {
    scanned: 0,
    removed: [],
    kept: [],
    prunedRepos: [],
  };

  let agentDirs: string[];
  try {
    agentDirs = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (err) {
    // No worktrees dir is the normal case for a gateway that never isolated a
    // child. Anything else is logged and the sweep ends — never thrown.
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      o.log?.(`[worktree-reaper] could not read ${root}: ${message(err)}`);
    }
    return result;
  }

  /** Repos touched by the sweep; each gets one prune pass at the end. */
  const repos = new Set<string>();

  for (const agentName of agentDirs) {
    const agentDir = join(root, agentName);
    let childIds: string[];
    try {
      childIds = (await readdir(agentDir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch (err) {
      o.log?.(`[worktree-reaper] could not read ${agentDir}: ${message(err)}`);
      continue;
    }

    for (const childId of childIds) {
      const path = join(agentDir, childId);
      result.scanned++;
      try {
        if (o.isLive?.(childId)) {
          result.kept.push({ path, reason: 'the child is still running' });
          continue;
        }
        const status = o.statusOf?.(childId);
        if (status && KEEP_STATUSES.has(status)) {
          result.kept.push({ path, reason: `the child is ${status} and resumable` });
          continue;
        }
        const workspace = await repoOf(path);
        if (!workspace) {
          // Not a linked worktree: no repository to remove it from, and no way
          // to tell a leaked checkout from a directory someone put here.
          result.kept.push({ path, reason: 'not a git worktree' });
          o.log?.(`[worktree-reaper] keeping ${path}: not a git worktree`);
          continue;
        }
        repos.add(workspace);
        const { removed, blocking, disposable } = await cleanupChildWorktree({ workspace, path });
        if (!removed) {
          const reason = `uncommitted work: ${blocking.slice(0, 5).join(', ')}`;
          result.kept.push({ path, reason });
          o.log?.(`[worktree-reaper] keeping the orphaned worktree ${path} — ${reason}`);
          continue;
        }
        result.removed.push(path);
        const discarded =
          disposable.length > 0 ? `, discarding ${disposable.slice(0, 5).join(', ')}` : '';
        o.log?.(`[worktree-reaper] removed the orphaned worktree ${path}${discarded}`);
      } catch (err) {
        result.kept.push({ path, reason: message(err) });
        o.log?.(`[worktree-reaper] could not reap ${path}: ${message(err)}`);
      }
    }
  }

  // Registrations whose directory is ALREADY gone cannot be found by scanning
  // the data dir, so they are swept from the repo side: one prune per repo the
  // sweep touched clears every `prunable` entry it left behind.
  for (const workspace of repos) {
    try {
      await run('git', ['-C', workspace, 'worktree', 'prune']);
      result.prunedRepos.push(workspace);
    } catch (err) {
      o.log?.(`[worktree-reaper] could not prune ${workspace}: ${message(err)}`);
    }
  }

  return result;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
