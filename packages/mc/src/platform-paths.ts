import { homedir } from 'node:os';
import { join } from 'node:path';

export function getPlatformDataDir(appName: string): string {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', appName);
  }
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg || join(homedir(), '.local', 'share');
  return join(base, appName);
}
