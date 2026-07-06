import { join } from 'node:path';
import { BrowserWindow, app } from 'electron';
import { autoUpdater } from 'electron-updater';
import { destroyCompanionWindow } from './companion-window.js';
import { registerIpcHandlers } from './ipc';
import { buildMainWindowOptions, revealWhenReady } from './main-window.js';
import { setupAutoUpdater } from './updater.js';

let mainWindow: BrowserWindow | undefined;

function getAppTitle(): string {
  if (!app.isPackaged) {
    const suffix = process.env.MC_DATA_DIR ? '(test)' : '(dev)';
    return `Mission Control ${suffix}`;
  }
  return 'Mission Control';
}

function createWindow(): void {
  const title = getAppTitle();
  mainWindow = new BrowserWindow(
    buildMainWindowOptions(title, join(__dirname, '../preload/index.js')),
  );
  revealWhenReady(mainWindow);

  // Prevent the HTML <title> from overriding our environment-aware title
  mainWindow.on('page-title-updated', (e) => {
    e.preventDefault();
  });

  mainWindow.on('closed', () => {
    // The companion widget hides when the main window closes; this also
    // preserves `window-all-closed` semantics (no orphan always-on-top window).
    destroyCompanionWindow();
    mainWindow = undefined;
  });

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(async () => {
  // Show environment badge on macOS dock icon for test builds
  // (dev builds get "Dash (dev)" via the plist patch in scripts/patch-electron-name.sh)
  if (!app.isPackaged && process.platform === 'darwin' && process.env.MC_DATA_DIR) {
    app.dock.setBadge('TEST');
  }
  await setupAutoUpdater(autoUpdater, app.isPackaged);
  autoUpdater.on('update-available', (info: { version: string }) => {
    mainWindow?.webContents.send('update:available', { version: info.version });
  });
  await registerIpcHandlers(() => mainWindow);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
