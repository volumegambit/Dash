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
