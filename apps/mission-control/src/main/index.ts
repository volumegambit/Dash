import { delimiter, join } from 'node:path';
import { BrowserWindow, app } from 'electron';
import { autoUpdater } from 'electron-updater';
import { registerIpcHandlers } from './ipc';
import { setupAutoUpdater } from './updater.js';

// When packaged, prepend the bundled opencode binary directory to PATH so
// spawn('opencode') in @opencode-ai/sdk resolves the bundled binary.
if (app.isPackaged) {
  const binDir = join(process.resourcesPath, 'bin');
  process.env.PATH = `${binDir}${delimiter}${process.env.PATH ?? ''}`;
}

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
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title,
    backgroundColor: '#0a0a0a',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.on('closed', () => {
    mainWindow = undefined;
  });

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

// Set dock/taskbar name to include environment suffix in non-production builds
if (!app.isPackaged) {
  const suffix = process.env.MC_DATA_DIR ? '(test)' : '(dev)';
  app.setName(`Dash ${suffix}`);
}

app.whenReady().then(async () => {
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
