import { ROYAL_GUARD_FRAMES } from './guardFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/**
 * Animated royal guard: PixelLab-generated 92x92 bitmap frames per mood —
 * stands rigidly at attention while idle, marches in place while working, only its eyes dart when a session needs you, cracks a tiny smile and salutes on done, the bearskin hat slips over its eyes on error — plus the shared collar badge hue per mood.
 */
export const royalGuardAnimated: AnimatedPetSprite = {
  kind: 'royal-guard',
  name: 'Royal Guard',
  moods: {
    idle: { frames: ROYAL_GUARD_FRAMES.idle, fps: 3, collar: MOOD_COLLARS.idle },
    working: { frames: ROYAL_GUARD_FRAMES.working, fps: 8, collar: MOOD_COLLARS.working },
    needs: { frames: ROYAL_GUARD_FRAMES.needs, fps: 5, collar: MOOD_COLLARS.needs },
    done: { frames: ROYAL_GUARD_FRAMES.done, fps: 7, collar: MOOD_COLLARS.done },
    error: { frames: ROYAL_GUARD_FRAMES.error, fps: 7, collar: MOOD_COLLARS.error },
  },
};
