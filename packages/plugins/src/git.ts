import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

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
      await execFileAsync('git', args);
    } catch {
      // `--branch` rejects commit SHAs; fall back to a full clone + checkout.
      await rm(tmp, { recursive: true, force: true });
      await mkdir(tmp, { recursive: true });
      await execFileAsync('git', ['clone', remote, tmp]);
      if (ref) await execFileAsync('git', ['-C', tmp, 'checkout', ref]);
    }
    return { dir: tmp, cleanup };
  } catch (err) {
    await cleanup();
    throw err;
  }
}
