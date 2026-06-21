import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Root directory for everything Dash stores on disk.
 *
 * Defaults to `~/.dash`. Override the entire tree by setting `$DASH_HOME`
 * (e.g. for tests, CI, multiple profiles, or a custom install). An empty or
 * whitespace-only value is treated as unset.
 *
 * Everything Dash owns lives under this single root, split into component
 * subdirectories so the layout is self-explanatory when browsed in a file
 * manager:
 *
 * ```
 * ~/.dash/
 * ├── gateway/      gateway runtime data (credentials, sessions, dbs, …)
 * ├── desktop/      Mission Control desktop app data
 * ├── logs/         shared logs (mc.log, gateway.log)
 * └── workspaces/   per-agent workspaces
 * ```
 */
export function dashHome(): string {
  const override = process.env.DASH_HOME?.trim();
  return override ? override : join(homedir(), '.dash');
}

/** Gateway runtime data: `~/.dash/gateway`. */
export function gatewayDir(): string {
  return join(dashHome(), 'gateway');
}

/** Mission Control desktop app data: `~/.dash/desktop`. */
export function desktopDir(): string {
  return join(dashHome(), 'desktop');
}

/** Shared logs: `~/.dash/logs`. */
export function logsDir(): string {
  return join(dashHome(), 'logs');
}

/** Per-agent workspaces: `~/.dash/workspaces`. */
export function workspacesDir(): string {
  return join(dashHome(), 'workspaces');
}
