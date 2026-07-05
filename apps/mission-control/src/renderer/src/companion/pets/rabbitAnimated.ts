import { RABBIT_FRAMES } from './rabbitFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/**
 * Animated rabbit: PixelLab-generated 92x92 bitmap frames per mood — calm
 * idle, digging furiously while working (dirt flying), standing upright and
 * alert when a session needs you, hopping when done, thumping a hind foot on
 * error — plus the shared collar badge hue per mood.
 */
export const rabbitAnimated: AnimatedPetSprite = {
  kind: 'rabbit',
  name: 'Rabbit',
  moods: {
    idle: { frames: RABBIT_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: RABBIT_FRAMES.working, fps: 10, collar: MOOD_COLLARS.working },
    needs: { frames: RABBIT_FRAMES.needs, fps: 6, collar: MOOD_COLLARS.needs },
    done: { frames: RABBIT_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: RABBIT_FRAMES.error, fps: 8, collar: MOOD_COLLARS.error },
  },
};
