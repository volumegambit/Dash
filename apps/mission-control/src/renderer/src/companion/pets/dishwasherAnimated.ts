import { DISHWASHER_FRAMES } from './dishwasherFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/** Dishwasher: PixelLab 92px frames per mood. */
export const dishwasherAnimated: AnimatedPetSprite = {
  kind: 'dishwasher',
  name: 'Dishwasher',
  moods: {
    idle: { frames: DISHWASHER_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: DISHWASHER_FRAMES.working, fps: 10, collar: MOOD_COLLARS.working },
    needs: { frames: DISHWASHER_FRAMES.needs, fps: 6, collar: MOOD_COLLARS.needs },
    done: { frames: DISHWASHER_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: DISHWASHER_FRAMES.error, fps: 8, collar: MOOD_COLLARS.error },
  },
};
