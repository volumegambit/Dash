import { cp, mkdir, rename, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
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
 * Move `src` to `dest`. Uses an atomic rename (instant, even for large dirs, on
 * the same filesystem) and falls back to a recursive copy + remove when the
 * source and destination live on different devices (`EXDEV`).
 */
async function move(src: string, dest: string): Promise<void> {
  try {
    await rename(src, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
      await cp(src, dest, { recursive: true });
      await rm(src, { recursive: true, force: true });
    } else {
      throw err;
    }
  }
}

/**
 * One-time, idempotent migration of legacy on-disk data into the `~/.dash`
 * layout. Safe to call on every startup: each move only runs when its
 * destination is absent and its source exists.
 *
 * - Gateway data and agent workspaces move wholesale (everything there is
 *   current).
 * - The desktop dir moves selectively — only the files Mission Control reads
 *   today — and its `logs/` is split out to the shared logs dir.
 *
 * Skipped entirely when `$DASH_HOME` is set (a custom root signals the user is
 * managing their own layout), unless `newRoot` is passed explicitly.
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

  // 1. Gateway data — entirely current; move the whole directory.
  if (!(await exists(gatewayDest)) && (await exists(legacyGateway))) {
    await mkdir(newRoot, { recursive: true });
    await move(legacyGateway, gatewayDest);
    result.moved.push(`gateway: ${legacyGateway} -> ${gatewayDest}`);
  }

  // 2. Agent workspaces — move the whole directory.
  if (!(await exists(workspacesDest)) && (await exists(legacyWorkspaces))) {
    await mkdir(newRoot, { recursive: true });
    await move(legacyWorkspaces, workspacesDest);
    result.moved.push(`workspaces: ${legacyWorkspaces} -> ${workspacesDest}`);
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

    // Logs split out to the shared logs dir.
    const legacyLogs = join(legacyDesktop, 'logs');
    if (!(await exists(logsDest)) && (await exists(legacyLogs))) {
      await mkdir(newRoot, { recursive: true });
      await move(legacyLogs, logsDest);
      result.moved.push(`logs: ${legacyLogs} -> ${logsDest}`);
      movedFromDesktop = true;
    }

    if (movedFromDesktop) {
      result.notes.push(
        `Legacy files may remain at ${legacyDesktop} (old secrets, caches, etc.) and are safe to delete.`,
      );
    }
  }

  return result;
}
