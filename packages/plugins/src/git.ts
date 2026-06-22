import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Bound a single git invocation: kill a hanging clone after this many ms (I2 —
 * a stalled/slow remote must not tie up the gateway indefinitely).
 */
const GIT_TIMEOUT_MS = 120_000;

/**
 * Cap git's captured stdout/stderr (I2). git writes progress to stderr; 10 MiB
 * is generous for output while still bounding memory if a remote floods it.
 */
const GIT_MAX_BUFFER = 10 * 1024 * 1024;

/** Common bounds applied to every git `execFile` (timeout + maxBuffer). */
const GIT_EXEC_OPTS = { timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER } as const;

/** A repository cloned into a temp dir, plus a cleanup for its temp root. */
export interface ClonedRepo {
  /** Absolute path to the freshly cloned working tree (an `mkdtemp` root). */
  dir: string;
  /** Remove the temp dir. Safe to call more than once. */
  cleanup: () => Promise<void>;
}

/**
 * Clone `remote` into a fresh temp dir with a shallow `--depth 1` clone,
 * optionally checking out `ref`.
 *
 * `--branch <ref>` is tried first (it works for branches and tags). Git rejects
 * `--branch` for a commit SHA, so on failure we fall back to a full clone
 * followed by `git checkout <ref>`. This mirrors the install flow's git fetch.
 *
 * The caller owns cleanup: on success they MUST call `cleanup()` (typically in a
 * `finally`); on a clone failure this helper cleans up its own temp dir before
 * throwing, so callers never leak a temp dir for a failed clone.
 *
 * @param prefix `mkdtemp` filename prefix, e.g. `dash-marketplace-git-`.
 * @throws the underlying git error (callers map it to a structured error).
 */
export async function gitCloneToTemp(
  remote: string,
  ref: string | undefined,
  prefix: string,
): Promise<ClonedRepo> {
  const tmp = await mkdtemp(join(tmpdir(), prefix));
  const cleanup = async (): Promise<void> => {
    await rm(tmp, { recursive: true, force: true });
  };
  try {
    try {
      const args = ['clone', '--depth', '1'];
      if (ref) args.push('--branch', ref);
      args.push(remote, tmp);
      // Bounded (timeout + maxBuffer); argv form, never a shell — no injection.
      await execFileAsync('git', args, GIT_EXEC_OPTS);
    } catch {
      // `--branch` rejects commit SHAs; fall back to a full clone + checkout.
      await rm(tmp, { recursive: true, force: true });
      await mkdir(tmp, { recursive: true });
      await execFileAsync('git', ['clone', remote, tmp], GIT_EXEC_OPTS);
      if (ref) await execFileAsync('git', ['-C', tmp, 'checkout', ref], GIT_EXEC_OPTS);
    }
    return { dir: tmp, cleanup };
  } catch (err) {
    await cleanup();
    throw err;
  }
}
