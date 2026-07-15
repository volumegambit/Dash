/**
 * Pure geometry helper for the squad widget window. Kept in its own module
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

/** Per-member sprite width (must match MEMBER_SIZE in CompanionSquad). */
const MEMBER_WIDTH = 88;

/** Gap between members in the squad row (must match the renderer's row gap). */
const MEMBER_GAP = 4;

/**
 * Side padding on each edge (must match SIDE_PADDING in CompanionSquad). At
 * least half the speech bubble's overhang beyond a member slot
 * ((132 - 88) / 2 = 22), so an edge member's bubble is never clipped.
 */
const SIDE_PADDING = 24;

/**
 * Window height: an 88px sprite row + the 22px stagger + headroom for the
 * speech bubbles floating above the staggered members.
 */
const WINDOW_HEIGHT = 200;

/**
 * The widget window size for the number of visible squad members (one per
 * running agent — see visibleMemberCount): the member row plus side padding
 * wide enough that edge speech bubbles never clip.
 */
export function windowSizeFor(memberCount: number): WindowSize {
  return {
    width: memberCount * MEMBER_WIDTH + (memberCount - 1) * MEMBER_GAP + 2 * SIDE_PADDING,
    height: WINDOW_HEIGHT,
  };
}

/**
 * Resize the widget in place, keeping its bottom-right corner anchored (the
 * default resting corner), so a change in visible member count grows/shrinks
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
