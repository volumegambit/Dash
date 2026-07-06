import { DETECTIVE_FRAMES } from './detectiveFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/** Detective: PixelLab 92px frames per mood. */
export const detectiveAnimated: AnimatedPetSprite = {
  kind: 'detective',
  name: 'Detective',
  moods: {
    idle: { frames: DETECTIVE_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: DETECTIVE_FRAMES.working, fps: 10, collar: MOOD_COLLARS.working },
    needs: { frames: DETECTIVE_FRAMES.needs, fps: 6, collar: MOOD_COLLARS.needs },
    done: { frames: DETECTIVE_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: DETECTIVE_FRAMES.error, fps: 8, collar: MOOD_COLLARS.error },
  },
};
