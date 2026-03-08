import type { AppUpdater } from 'electron-updater';

export async function setupAutoUpdater(updater: AppUpdater, isPackaged: boolean): Promise<void> {
  if (!isPackaged) return;

  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;

  await updater.checkForUpdatesAndNotify();
}
