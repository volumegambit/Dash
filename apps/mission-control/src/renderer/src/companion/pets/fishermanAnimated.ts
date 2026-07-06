import { FISHERMAN_FRAMES } from './fishermanFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/** Fisherman: PixelLab 92px frames per mood. */
export const fishermanAnimated: AnimatedPetSprite = {
  kind: 'fisherman',
  name: 'Fisherman',
  moods: {
    idle: { frames: FISHERMAN_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: FISHERMAN_FRAMES.working, fps: 10, collar: MOOD_COLLARS.working },
    needs: { frames: FISHERMAN_FRAMES.needs, fps: 6, collar: MOOD_COLLARS.needs },
    done: { frames: FISHERMAN_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: FISHERMAN_FRAMES.error, fps: 8, collar: MOOD_COLLARS.error },
  },
};
