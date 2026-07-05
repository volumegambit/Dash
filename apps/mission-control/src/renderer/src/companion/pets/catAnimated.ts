import { CAT_FRAMES } from './catFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/**
 * Animated cat: PixelLab-generated 92x92 bitmap frames per mood — calm idle,
 * trotting while working, sitting when a session needs you, jumping when
 * done, bristling on error — plus the shared collar badge hue per mood.
 */
export const catAnimated: AnimatedPetSprite = {
  kind: 'cat',
  name: 'Cat',
  moods: {
    idle: { frames: CAT_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: CAT_FRAMES.working, fps: 10, collar: MOOD_COLLARS.working },
    needs: { frames: CAT_FRAMES.needs, fps: 5, collar: MOOD_COLLARS.needs },
    done: { frames: CAT_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: CAT_FRAMES.error, fps: 7, collar: MOOD_COLLARS.error },
  },
};
