import { join } from 'node:path';
import type { SettingsStore } from '@dash/mc';
import { BrowserWindow, app, screen } from 'electron';
import type { CompanionStatus } from '../shared/ipc.js';
import { clampToVisible } from './companion-window-clamp.js';

/** Widget window size: the tree sprite at 128px plus a little padding. */
const WIN = { width: 140, height: 190 };

/** Margin from the screen edge when placing the widget in its default corner. */
const MARGIN = 24;

let companionWindow: BrowserWindow | undefined;

/**
 * Default resting spot: bottom-right of the primary display's work area, inset
 * by the window size and a small margin.
 */
function defaultCorner(): { x: number; y: number } {
  const { workArea } = screen.getPrimaryDisplay();
  return {
    x: workArea.x + workArea.width - WIN.width - MARGIN,
    y: workArea.y + workArea.height - WIN.height - MARGIN,
  };
}

/**
 * Create the always-on-top companion widget window. Idempotent — a second call
 * while the window exists is a no-op. The window loads its persisted position
 * (clamped to a currently-visible display), persists moves back to settings,
 * and asks the main window to replay statuses once the widget has loaded so it
 * never starts blank.
 */
export function createCompanionWindow(opts: {
  settings: SettingsStore;
  getMainWindow: () => BrowserWindow | undefined;
}): void {
  if (companionWindow) return; // idempotent
  void opts.settings.get().then((s) => {
    if (companionWindow) return; // a concurrent create won the race
    const pos = clampToVisible(
      s.companionWindowPos ?? defaultCorner(),
      screen.getAllDisplays(),
      WIN,
    );
    companionWindow = new BrowserWindow({
      ...WIN,
      x: pos.x,
      y: pos.y,
      frame: false,
      transparent: true,
      resizable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    companionWindow.setAlwaysOnTop(true, 'floating');
    companionWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    companionWindow.on('moved', () => {
      const [x, y] = companionWindow?.getPosition() ?? [0, 0];
      void opts.settings.set({ companionWindowPos: { x, y } });
    });
    companionWindow.on('closed', () => {
      companionWindow = undefined;
    });
    if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
      void companionWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}/companion.html`);
    } else {
      void companionWindow.loadFile(join(__dirname, '../renderer/companion.html'));
    }
    // Never start blank: once the widget is ready, ask the main window to
    // republish the current per-session statuses.
    companionWindow.webContents.on('did-finish-load', () => {
      opts.getMainWindow()?.webContents.send('companion:replay');
    });
  });
}

/** Close and clear the companion widget window if it exists. */
export function destroyCompanionWindow(): void {
  if (companionWindow && !companionWindow.isDestroyed()) {
    companionWindow.close();
  }
  companionWindow = undefined;
}

/** The current companion widget window, if open. */
export function getCompanionWindow(): BrowserWindow | undefined {
  return companionWindow;
}

/** Push the latest per-session statuses into the widget window, if open. */
export function forwardStatuses(statuses: CompanionStatus[]): void {
  if (companionWindow && !companionWindow.isDestroyed()) {
    companionWindow.webContents.send('companion:statuses', statuses);
  }
}
