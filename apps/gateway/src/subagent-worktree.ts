import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
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
 * Take an isolated child's worktree down — but only if it is EMPTY-HANDED.
 *
 * `git status --porcelain` covers modifications, staged changes AND untracked
 * files, so anything the child produced and did not commit keeps the directory
 * alive. Removing it would destroy work the user may want; the caller surfaces
 * the kept path instead.
 */
export async function cleanupChildWorktree(o: {
  workspace: string;
  path: string;
}): Promise<{ removed: boolean }> {
  const { stdout } = await run('git', ['-C', o.path, 'status', '--porcelain']);
  if (stdout.trim() !== '') return { removed: false };
  await run('git', ['-C', o.workspace, 'worktree', 'remove', o.path]);
  return { removed: true };
}
