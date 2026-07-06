/**
 * Pure geometry helper for the companion widget window. Kept in its own module
 * (no `electron` import) so it can be unit-tested under vitest, which cannot
 * load the `electron` runtime.
 */

export interface DisplayBounds {
  bounds: { x: number; y: number; width: number; height: number };
}

export interface WindowSize {
  width: number;
  height: number;
}

/** Compact window for a single pet (128px sprite + padding). */
export const PET_WINDOW: WindowSize = { width: 140, height: 190 };

/**
 * Wide window for a crew's five-pet fleet: 5 × 88px sprites + gaps and side
 * padding, with vertical headroom for the staggered row and speech bubbles.
 */
export const CREW_WINDOW: WindowSize = { width: 476, height: 200 };

/**
 * The widget window size for a selection string. Crew selections (prefixed
 * `crew:`) get the wide fleet window; everything else — including old persisted
 * pet ids and unknown values — gets the compact pet window.
 */
export function windowSizeFor(selection: string): WindowSize {
  return selection.startsWith('crew:') ? CREW_WINDOW : PET_WINDOW;
}

/**
 * Resize the widget in place, keeping its bottom-right corner anchored (the
 * default resting corner), so switching between a pet and a crew grows/shrinks
 * toward the screen edge rather than jumping. Returns the new top-left origin
 * for `oldSize → newSize` given the current top-left `pos`.
 */
export function anchoredResize(
  pos: { x: number; y: number },
  oldSize: WindowSize,
  newSize: WindowSize,
): { x: number; y: number } {
  return {
    x: pos.x + oldSize.width - newSize.width,
    y: pos.y + oldSize.height - newSize.height,
  };
}

/** Minimum on-screen overlap (px) required in each axis to keep a position. */
const MIN_OVERLAP = 40;

/**
 * Returns `pos` unchanged if the window rect at `pos` intersects any display's
 * bounds by at least 40px in both axes; otherwise centers the window on the
 * primary (first) display. Guards against positions stranded on an unplugged
 * monitor or dragged almost entirely off-screen.
 */
export function clampToVisible(
  pos: { x: number; y: number },
  displays: DisplayBounds[],
  win: WindowSize,
): { x: number; y: number } {
  const visible = displays.some(({ bounds }) => {
    const overlapX =
      Math.min(pos.x + win.width, bounds.x + bounds.width) - Math.max(pos.x, bounds.x);
    const overlapY =
      Math.min(pos.y + win.height, bounds.y + bounds.height) - Math.max(pos.y, bounds.y);
    return overlapX >= MIN_OVERLAP && overlapY >= MIN_OVERLAP;
  });

  if (visible) return pos;

  const primary = displays[0];
  if (!primary) return pos;
  return {
    x: primary.bounds.x + (primary.bounds.width - win.width) / 2,
    y: primary.bounds.y + (primary.bounds.height - win.height) / 2,
  };
}
