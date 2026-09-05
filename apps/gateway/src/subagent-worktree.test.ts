import { execFile } from 'node:child_process';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  WORKTREE_REQUIRES_GIT,
  childWorktreePath,
  cleanupChildWorktree,
  createChildWorktree,
} from './subagent-worktree.js';

const run = promisify(execFile);

/**
 * Every git call in these tests carries its own identity and ignores the
 * developer's global config, so the suite behaves identically on a machine with
 * no `user.email` set and on one with an opinionated `~/.gitconfig`. The env is
 * ALSO stubbed onto `process.env` in beforeEach so the implementation's own
 * `git` calls (which inherit the process env) are equally insulated.
 */
const IDENTITY = ['-c', 'user.email=t@example.com', '-c', 'user.name=Test'];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', [...IDENTITY, '-C', cwd, ...args]);
  return stdout;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** A repo with one commit on `main` holding `base.txt`. */
async function initRepo(dir: string): Promise<void> {
  await git(dir, 'init', '-b', 'main');
  await writeFile(join(dir, 'base.txt'), 'base\n');
  await git(dir, 'add', '-A');
  await git(dir, 'commit', '-m', 'first');
}

/**
 * Every case here shells out to real `git` several times, which is comfortably
 * slower than vitest's 5s default on a loaded machine.
 */
describe('subagent worktree isolation', { timeout: 30_000 }, () => {
  let workspace: string;
  let dataDir: string;

  beforeEach(async () => {
    vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null');
    vi.stubEnv('GIT_CONFIG_SYSTEM', '/dev/null');
    workspace = await mkdtemp(join(tmpdir(), 'wt-ws-'));
    dataDir = await mkdtemp(join(tmpdir(), 'wt-data-'));
    await initRepo(workspace);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(workspace, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  });

  describe('createChildWorktree', () => {
    it('creates <dataDir>/worktrees/<agentName>/<childId> with the workspace files', async () => {
      const { path } = await createChildWorktree({
        workspace,
        dataDir,
        agentName: 'researcher',
        childId: 'w-01',
      });

      expect(path).toBe(join(dataDir, 'worktrees', 'researcher', 'w-01'));
      expect(path).toBe(childWorktreePath({ dataDir, agentName: 'researcher', childId: 'w-01' }));
      expect(await exists(join(path, 'base.txt'))).toBe(true);
      // Registered with the parent repo, so cleanup can remove it properly.
      expect(await git(workspace, 'worktree', 'list')).toContain(path);
    });

    /**
     * Platform Adaptation 5: the branch point is the workspace's CURRENT HEAD,
     * not the default branch. A Dash workspace is often parked on a feature
     * branch with no remote, and the child must see the files the user is
     * looking at.
     */
    it('branches from the current HEAD, not the default branch', async () => {
      await git(workspace, 'checkout', '-b', 'feature');
      await writeFile(join(workspace, 'feature.txt'), 'only on feature\n');
      await git(workspace, 'add', '-A');
      await git(workspace, 'commit', '-m', 'feature work');

      const { path } = await createChildWorktree({
        workspace,
        dataDir,
        agentName: 'researcher',
        childId: 'w-02',
      });

      expect(await exists(join(path, 'feature.txt'))).toBe(true);
      // Detached: the child never occupies (or moves) the parent's branch.
      expect((await git(path, 'rev-parse', '--abbrev-ref', 'HEAD')).trim()).toBe('HEAD');
      expect((await git(path, 'rev-parse', 'HEAD')).trim()).toBe(
        (await git(workspace, 'rev-parse', 'HEAD')).trim(),
      );
    });

    it('throws the exact message when the workspace is not a git repo', async () => {
      const plain = await mkdtemp(join(tmpdir(), 'wt-plain-'));
      try {
        await expect(
          createChildWorktree({ workspace: plain, dataDir, agentName: 'a', childId: 'w-03' }),
        ).rejects.toThrow(WORKTREE_REQUIRES_GIT);
        expect(WORKTREE_REQUIRES_GIT).toBe('isolation: worktree requires a git workspace');
      } finally {
        await rm(plain, { recursive: true, force: true });
      }
    });

    it('throws the exact message when the workspace does not exist', async () => {
      await expect(
        createChildWorktree({
          workspace: join(workspace, 'no-such-dir'),
          dataDir,
          agentName: 'a',
          childId: 'w-04',
        }),
      ).rejects.toThrow(WORKTREE_REQUIRES_GIT);
    });
  });

  describe('cleanupChildWorktree', () => {
    it('removes the worktree when it is clean', async () => {
      const { path } = await createChildWorktree({
        workspace,
        dataDir,
        agentName: 'researcher',
        childId: 'w-10',
      });

      await expect(cleanupChildWorktree({ workspace, path })).resolves.toEqual({ removed: true });
      expect(await exists(path)).toBe(false);
      expect(await git(workspace, 'worktree', 'list')).not.toContain(path);
    });

    it('keeps the worktree when a tracked file was modified', async () => {
      const { path } = await createChildWorktree({
        workspace,
        dataDir,
        agentName: 'researcher',
        childId: 'w-11',
      });
      await writeFile(join(path, 'base.txt'), 'the child changed this\n');

      await expect(cleanupChildWorktree({ workspace, path })).resolves.toEqual({ removed: false });
      expect(await exists(join(path, 'base.txt'))).toBe(true);
      expect(await git(workspace, 'worktree', 'list')).toContain(path);
    });

    it('keeps the worktree when the child left untracked files', async () => {
      const { path } = await createChildWorktree({
        workspace,
        dataDir,
        agentName: 'researcher',
        childId: 'w-12',
      });
      await writeFile(join(path, 'findings.md'), '# what I found\n');

      await expect(cleanupChildWorktree({ workspace, path })).resolves.toEqual({ removed: false });
      expect(await exists(join(path, 'findings.md'))).toBe(true);
    });
  });
});
