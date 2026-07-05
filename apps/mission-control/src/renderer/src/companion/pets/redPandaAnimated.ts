import { RED_PANDA_FRAMES } from './redPandaFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/**
 * Animated red panda: PixelLab-generated 92x92 bitmap frames per mood — slow
 * idle sway, running while working, sitting when a session needs you, jumping
 * when done, bristling on error — plus the shared collar badge hue per mood.
 */
export const redPandaAnimated: AnimatedPetSprite = {
  kind: 'red-panda',
  name: 'Red panda',
  moods: {
    idle: { frames: RED_PANDA_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: RED_PANDA_FRAMES.working, fps: 10, collar: MOOD_COLLARS.working },
    needs: { frames: RED_PANDA_FRAMES.needs, fps: 5, collar: MOOD_COLLARS.needs },
    done: { frames: RED_PANDA_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: RED_PANDA_FRAMES.error, fps: 7, collar: MOOD_COLLARS.error },
  },
};
