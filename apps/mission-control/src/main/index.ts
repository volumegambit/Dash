import { join } from 'node:path';
import { BrowserWindow, app, nativeImage } from 'electron';
import { autoUpdater } from 'electron-updater';
import { destroyCompanionWindow } from './companion-window.js';
import { registerIpcHandlers, releaseRendererConversationWatches } from './ipc';
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

  // A RELOAD — ⌘R, which Electron's default menu offers in a packaged build
  // because nothing here ever calls `Menu.setApplicationMenu` — fires no
  // `closed`, so without this the holds the outgoing renderer took would stay
  // counted in main for the life of the app, and the fresh renderer's own
  // release could never take them to 0. The `webContents.id` survives a
  // reload, which is exactly why the release has to happen HERE rather than
  // being inferred from a new id.
  //
  // `isSameDocument` is the guard that matters: the router's pushState
  // navigations fire this event too, and releasing on those would drop every
  // child socket on every route change.
  //
  // The id is CAPTURED, not read off the module-level `mainWindow` binding
  // that `closed` nulls: `releaseRendererConversationWatches(undefined)` takes
  // the window-close branch and drops EVERY holder's bucket, not this
  // renderer's. Not reachable today (the webContents is destroyed before
  // `closed` nulls it), and capturing removes the branch rather than reasoning
  // about it. (D7b M3 review, Minor 1.)
  const watchedContents = mainWindow.webContents;
  watchedContents.on('did-start-navigation', (details) => {
    if (!details.isMainFrame || details.isSameDocument) return;
    releaseRendererConversationWatches(watchedContents.id);
  });

  mainWindow.on('closed', () => {
    // The companion widget hides when the main window closes; this also
    // preserves `window-all-closed` semantics (no orphan always-on-top window).
    destroyCompanionWindow();
    // Every child-conversation watch belonged to the renderer that has just
    // gone. On macOS nothing else releases them: `window-all-closed` quits
    // only off darwin, so the sockets would outlive the window and the fresh
    // renderer an `activate` builds would take its own on top of them.
    releaseRendererConversationWatches();
    mainWindow = undefined;
  });

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(async () => {
  // In dev on macOS the dock shows the stock Electron icon, because the real
  // icon is only baked into the packaged .app by electron-builder. Apply it at
  // runtime so `mc:dev` shows the Dash icon. (No-op when packaged: the bundle
  // already carries build/icon.icns.)
  if (!app.isPackaged && process.platform === 'darwin') {
    const icon = nativeImage.createFromPath(join(__dirname, '../../build/icon.png'));
    if (!icon.isEmpty()) {
      app.dock.setIcon(icon);
    }
  }

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
