import { describe, expect, it, vi } from 'vitest';
import { buildMainWindowOptions, revealWhenReady } from './main-window.js';

describe('buildMainWindowOptions', () => {
  it('creates the window hidden to avoid the white-screen flash on startup', () => {
    const options = buildMainWindowOptions('Mission Control', '/preload/index.js');
    expect(options.show).toBe(false);
  });

  it('keeps the dark backgroundColor as a fallback for post-paint gaps', () => {
    const options = buildMainWindowOptions('Mission Control', '/preload/index.js');
    expect(options.backgroundColor).toBe('#0a0a0a');
  });

  it('applies the given title and preload path with isolation settings intact', () => {
    const options = buildMainWindowOptions('Mission Control (dev)', '/preload/index.js');
    expect(options.title).toBe('Mission Control (dev)');
    expect(options.webPreferences).toEqual({
      preload: '/preload/index.js',
      contextIsolation: true,
      nodeIntegration: false,
    });
  });

  it('keeps the existing window geometry', () => {
    const options = buildMainWindowOptions('Mission Control', '/preload/index.js');
    expect(options).toMatchObject({ width: 1200, height: 800, minWidth: 800, minHeight: 600 });
  });
});

describe('revealWhenReady', () => {
  function makeWindow({ destroyed = false } = {}) {
    let listener: (() => void) | undefined;
    return {
      once: vi.fn((_event: 'ready-to-show', fn: () => void) => {
        listener = fn;
      }),
      show: vi.fn(),
      isDestroyed: vi.fn(() => destroyed),
      fireReadyToShow: () => listener?.(),
    };
  }

  it('shows the window once ready-to-show fires', () => {
    const win = makeWindow();
    revealWhenReady(win);
    expect(win.show).not.toHaveBeenCalled();
    win.fireReadyToShow();
    expect(win.show).toHaveBeenCalledOnce();
  });

  it('does not show a window that was destroyed before first paint', () => {
    const win = makeWindow({ destroyed: true });
    revealWhenReady(win);
    win.fireReadyToShow();
    expect(win.show).not.toHaveBeenCalled();
  });
});
