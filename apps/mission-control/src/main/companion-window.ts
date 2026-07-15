import { join } from 'node:path';
import type { SettingsStore } from '@dash/mc';
import { BrowserWindow, app, screen } from 'electron';
import type { CompanionAgentStatus, CompanionSelection } from '../shared/ipc.js';
import { visibleMemberCount } from '../shared/squad.js';
import { anchoredResize, clampToVisible, windowSizeFor } from './companion-window-clamp.js';

/** Margin from the screen edge when placing the widget in its default corner. */
const MARGIN = 24;

let companionWindow: BrowserWindow | undefined;

/**
 * How many squad members the last published statuses put on screen (one per
 * running agent), so the window sizes itself correctly when it (re)opens —
 * before the renderer has replayed. Defaults to the single idle member.
 */
let currentMemberCount = 1;

/**
 * Tracks the latest requested visibility. Because `createCompanionWindow` reads
 * settings asynchronously before the window exists, a `setVisible(false)` that
 * arrives mid-create would otherwise be silently dropped (no window to destroy)
 * and the create would then show a window the user just hid. Callers set this
 * before create/destroy; the async create honors it when it resolves.
 */
let desiredVisible = false;

/**
 * Default resting spot: bottom-right of the primary display's work area, inset
 * by the current window size and a small margin.
 */
function defaultCorner(size: { width: number; height: number }): { x: number; y: number } {
  const { workArea } = screen.getPrimaryDisplay();
  return {
    x: workArea.x + workArea.width - size.width - MARGIN,
    y: workArea.y + workArea.height - size.height - MARGIN,
  };
}

/**
 * Create the always-on-top squad widget window. Idempotent — a second call
 * while the window exists is a no-op. The window is sized for the current
 * visible member count (one per running agent), loads its persisted position
 * (clamped to a currently-visible display), persists moves back to settings,
 * and asks the main window to replay statuses once the widget has loaded so it
 * never starts blank.
 */
export function createCompanionWindow(opts: {
  settings: SettingsStore;
  getMainWindow: () => BrowserWindow | undefined;
}): void {
  desiredVisible = true;
  if (companionWindow) return; // idempotent
  void opts.settings.get().then((s) => {
    if (companionWindow) return; // a concurrent create won the race
    if (!desiredVisible) return; // hidden again while we were reading settings
    const size = windowSizeFor(currentMemberCount);
    const pos = clampToVisible(
      s.companionWindowPos ?? defaultCorner(size),
      screen.getAllDisplays(),
      size,
    );
    companionWindow = new BrowserWindow({
      ...size,
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
    // On macOS, setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    // implicitly removes the app from the dock (electron/electron#26350), which
    // would make the dock tile vanish once the widget opens even though the main
    // window is still up. Re-show it to keep the app's dock presence.
    if (process.platform === 'darwin') {
      void app.dock?.show();
    }
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
    // republish the current per-session statuses and selection.
    companionWindow.webContents.on('did-finish-load', () => {
      const main = opts.getMainWindow();
      if (main && !main.webContents.isDestroyed()) {
        main.webContents.send('companion:replay');
      }
    });
  });
}

/** Close and clear the squad widget window if it exists. */
export function destroyCompanionWindow(): void {
  desiredVisible = false;
  if (companionWindow && !companionWindow.isDestroyed()) {
    companionWindow.close();
  }
  companionWindow = undefined;
}

/** The current squad widget window, if open. */
export function getCompanionWindow(): BrowserWindow | undefined {
  return companionWindow;
}

/**
 * Push the latest per-agent session statuses into the widget window, if open,
 * first resizing the window to fit one squad member per running agent. The
 * resize keeps the window's bottom-right corner anchored (so the row grows
 * toward the screen edge) and re-clamps to a visible display.
 */
export function forwardStatuses(statuses: CompanionAgentStatus[]): void {
  const previous = currentMemberCount;
  currentMemberCount = visibleMemberCount(statuses);
  if (!companionWindow || companionWindow.isDestroyed()) return;

  const oldSize = windowSizeFor(previous);
  const newSize = windowSizeFor(currentMemberCount);
  if (oldSize.width !== newSize.width || oldSize.height !== newSize.height) {
    const [x, y] = companionWindow.getPosition();
    const anchored = anchoredResize({ x, y }, oldSize, newSize);
    const clamped = clampToVisible(anchored, screen.getAllDisplays(), newSize);
    companionWindow.setBounds({
      x: Math.round(clamped.x),
      y: Math.round(clamped.y),
      width: newSize.width,
      height: newSize.height,
    });
  }

  companionWindow.webContents.send('companion:statuses', statuses);
}

/**
 * Push the selected squad into the widget window, if open. All squads render
 * the same window size (it depends only on the member count), so no resize.
 */
export function forwardPet(selection: CompanionSelection): void {
  if (companionWindow && !companionWindow.isDestroyed()) {
    companionWindow.webContents.send('companion:pet', selection);
  }
}
