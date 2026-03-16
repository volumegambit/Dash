import type { AppUpdater } from 'electron-updater';

export async function setupAutoUpdater(updater: AppUpdater, isPackaged: boolean): Promise<void> {
  if (!isPackaged) return;

  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;

  try {
    await updater.checkForUpdatesAndNotify();
  } catch (err) {
    console.warn('Auto-update check failed:', err instanceof Error ? err.message : err);
  }
}
