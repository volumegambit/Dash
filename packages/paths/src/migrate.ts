import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { dashHome } from './paths.js';
import { getPlatformDataDir } from './platform.js';

export interface MigrateOptions {
  /**
   * Target root for the new layout. Defaults to {@link dashHome}. Passing this
   * explicitly also bypasses the custom-`$DASH_HOME` skip (used by tests).
   */
  newRoot?: string;
  /** Legacy gateway data dir. Default: platform dir for `dash-gateway`. */
  legacyGatewayDir?: string;
  /** Legacy desktop/Mission Control data dir. Default: platform dir for `dash`. */
  legacyDesktopDir?: string;
  /** Legacy agent workspaces dir. Default: `~/dash-workspaces`. */
  legacyWorkspacesDir?: string;
}

export interface MigrationResult {
  /** True when migration was intentionally skipped (custom `$DASH_HOME`). */
  skipped: boolean;
  /** Human-readable lines describing what moved (for logging). */
  moved: string[];
  /** Non-fatal notes (e.g. legacy cruft left in place). */
  notes: string[];
}

/** Mission Control files the current app actually reads, by name under the
 * legacy desktop dir. Everything else there is dead weight from older
 * architectures (old secrets, caches, stale agents.json, a huge workspaces/)
 * and is deliberately left behind rather than dragged into the clean layout. */
const DESKTOP_ITEMS = ['settings.json', 'conversations', 'gateway-state.json'];

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Move `src` to `dest` atomically.
 *
 * Tries a rename first (instant, even for large dirs, on the same filesystem).
 * On a cross-device move (`EXDEV`) it copies to a sibling temp dir and then
 * renames that into place, so `dest` only ever appears once it is complete and
 * `src` is removed only after `dest` exists — a crash mid-copy leaves a
 * `.migrating` temp (cleaned on the next run) rather than a partial `dest`.
 */
async function move(src: string, dest: string): Promise<void> {
  try {
    await rename(src, dest);
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
  }
  const tmp = `${dest}.migrating`;
  await rm(tmp, { recursive: true, force: true });
  await cp(src, tmp, { recursive: true });
  await rename(tmp, dest);
  await rm(src, { recursive: true, force: true });
}

/** Replace a known legacy directory prefix in an absolute path. Returns the
 * path unchanged when it doesn't live under any migrated location (e.g. an
 * agent pointed at an external project directory). */
function remapPrefix(p: string, pairs: Array<[string, string]>): string {
  for (const [from, to] of pairs) {
    if (p === from) return to;
    if (p.startsWith(from + sep)) return to + p.slice(from.length);
  }
  return p;
}

/**
 * Rewrite absolute `config.workspace` paths in a migrated `agents.json` so that
 * agents whose workspaces lived under a moved location point at the new one.
 * Best-effort: silently skips a missing/unparseable/unexpected file.
 */
async function rewriteAgentWorkspaces(
  agentsPath: string,
  pairs: Array<[string, string]>,
  result: MigrationResult,
): Promise<void> {
  if (!(await exists(agentsPath))) return;
  let data: unknown;
  try {
    data = JSON.parse(await readFile(agentsPath, 'utf-8'));
  } catch {
    return;
  }
  if (!Array.isArray(data)) return;

  let changed = false;
  for (const agent of data) {
    const ws = (agent as { config?: { workspace?: unknown } })?.config?.workspace;
    if (typeof ws !== 'string') continue;
    const next = remapPrefix(ws, pairs);
    if (next !== ws) {
      (agent as { config: { workspace: string } }).config.workspace = next;
      changed = true;
    }
  }
  if (changed) {
    await writeFile(agentsPath, `${JSON.stringify(data, null, 2)}\n`);
    result.moved.push('agents.json: rewrote workspace paths to the new layout');
  }
}

/**
 * One-time, idempotent migration of legacy on-disk data into the `~/.dash`
 * layout. Safe to call on every startup: each move only runs when its
 * destination is absent and its source exists, and each move is atomic.
 *
 * - Gateway data and agent workspaces move wholesale (everything there is
 *   current).
 * - The desktop dir moves selectively — only the files Mission Control reads
 *   today — and its `logs/` is split out to the shared logs dir.
 * - Absolute workspace paths in the migrated `agents.json` are rewritten so
 *   existing agents keep pointing at their (now-moved) files.
 *
 * Skipped when `$DASH_HOME` is set (a custom root signals the user is managing
 * their own layout), unless `newRoot` is passed explicitly.
 */
export async function migrateLegacyLayout(opts: MigrateOptions = {}): Promise<MigrationResult> {
  const result: MigrationResult = { skipped: false, moved: [], notes: [] };

  if (!opts.newRoot && process.env.DASH_HOME?.trim()) {
    result.skipped = true;
    return result;
  }

  const newRoot = opts.newRoot ?? dashHome();
  const legacyGateway = opts.legacyGatewayDir ?? getPlatformDataDir('dash-gateway');
  const legacyDesktop = opts.legacyDesktopDir ?? getPlatformDataDir('dash');
  const legacyWorkspaces = opts.legacyWorkspacesDir ?? join(homedir(), 'dash-workspaces');

  const gatewayDest = join(newRoot, 'gateway');
  const desktopDest = join(newRoot, 'desktop');
  const logsDest = join(newRoot, 'logs');
  const workspacesDest = join(newRoot, 'workspaces');

  let gatewayMoved = false;
  let workspacesMoved = false;

  // 1. Gateway data — entirely current; move the whole directory.
  if (!(await exists(gatewayDest)) && (await exists(legacyGateway))) {
    await mkdir(newRoot, { recursive: true });
    await move(legacyGateway, gatewayDest);
    result.moved.push(`gateway: ${legacyGateway} -> ${gatewayDest}`);
    gatewayMoved = true;
  }

  // 2. Agent workspaces — move the whole directory.
  if (!(await exists(workspacesDest)) && (await exists(legacyWorkspaces))) {
    await mkdir(newRoot, { recursive: true });
    await move(legacyWorkspaces, workspacesDest);
    result.moved.push(`workspaces: ${legacyWorkspaces} -> ${workspacesDest}`);
    workspacesMoved = true;
  }

  // 3. Desktop (Mission Control) data — move only what MC reads today; leave
  //    legacy cruft in place rather than polluting the new layout.
  if (await exists(legacyDesktop)) {
    let movedFromDesktop = false;
    for (const name of DESKTOP_ITEMS) {
      const src = join(legacyDesktop, name);
      const dest = join(desktopDest, name);
      if (!(await exists(dest)) && (await exists(src))) {
        await mkdir(desktopDest, { recursive: true });
        await move(src, dest);
        result.moved.push(`desktop/${name}: ${src} -> ${dest}`);
        movedFromDesktop = true;
      }
    }

    // Logs split out to the shared logs dir, file by file so a pre-existing
    // logs dir (e.g. created by a prior gateway run) doesn't strand them.
    const legacyLogs = join(legacyDesktop, 'logs');
    if (await exists(legacyLogs)) {
      for (const name of await readdir(legacyLogs)) {
        const src = join(legacyLogs, name);
        const dest = join(logsDest, name);
        if (!(await exists(dest))) {
          await mkdir(logsDest, { recursive: true });
          await move(src, dest);
          result.moved.push(`logs/${name}: ${src} -> ${dest}`);
          movedFromDesktop = true;
        }
      }
    }

    if (movedFromDesktop) {
      result.notes.push(
        `Legacy files may remain at ${legacyDesktop} (old secrets, caches, etc.) and are safe to delete.`,
      );
    }
  }

  // 4. Fix up absolute workspace paths in the migrated agents.json so existing
  //    agents follow their relocated files (gateway-dir-relative workspaces and
  //    ~/dash-workspaces both move; external paths are left untouched).
  if (gatewayMoved || workspacesMoved) {
    await rewriteAgentWorkspaces(
      join(gatewayDest, 'agents.json'),
      [
        [legacyGateway, gatewayDest],
        [legacyWorkspaces, workspacesDest],
      ],
      result,
    );
  }

  return result;
}
