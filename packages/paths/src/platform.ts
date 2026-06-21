import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Per-platform application data directory used by Dash *before* the `~/.dash`
 * consolidation.
 *
 * Retained so {@link migrateLegacyLayout} can locate data left behind by older
 * versions (`getPlatformDataDir('dash')` for the desktop app,
 * `getPlatformDataDir('dash-gateway')` for the gateway). New code should use
 * the resolvers in `./paths.ts` instead.
 *
 * - macOS: `~/Library/Application Support/<appName>`
 * - Linux/other: `$XDG_DATA_HOME/<appName>` or `~/.local/share/<appName>`
 */
export function getPlatformDataDir(appName: string): string {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', appName);
  }
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg || join(homedir(), '.local', 'share');
  return join(base, appName);
}
