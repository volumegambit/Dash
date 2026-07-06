/**
 * Main-window construction helpers. Kept free of runtime `electron` imports
 * (type-only is fine) so they can be unit-tested under vitest, which cannot
 * load the `electron` runtime.
 */
import type { BrowserWindowConstructorOptions } from 'electron';

/**
 * Options for the main window. Created hidden (`show: false`) and revealed on
 * `ready-to-show` to avoid the white flash before the renderer's first paint;
 * the dark `backgroundColor` covers any repaint gaps after that.
 */
export function buildMainWindowOptions(
  title: string,
  preloadPath: string,
): BrowserWindowConstructorOptions {
  return {
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title,
    show: false,
    backgroundColor: '#0a0a0a',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
    },
  };
}

/** The subset of BrowserWindow that reveal-on-ready needs. */
export interface RevealableWindow {
  once(event: 'ready-to-show', listener: () => void): unknown;
  show(): void;
  isDestroyed(): boolean;
}

/**
 * Show a hidden window once the renderer has painted its first frame, unless
 * the window was closed before that (showing a destroyed window throws).
 */
export function revealWhenReady(win: RevealableWindow): void {
  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) {
      win.show();
    }
  });
}
