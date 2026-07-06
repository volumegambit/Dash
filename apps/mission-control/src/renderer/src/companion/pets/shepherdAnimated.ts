import { SHEPHERD_FRAMES } from './shepherdFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/** Shepherd: PixelLab 92px frames per mood. */
export const shepherdAnimated: AnimatedPetSprite = {
  kind: 'shepherd',
  name: 'Shepherd',
  moods: {
    idle: { frames: SHEPHERD_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: SHEPHERD_FRAMES.working, fps: 10, collar: MOOD_COLLARS.working },
    needs: { frames: SHEPHERD_FRAMES.needs, fps: 6, collar: MOOD_COLLARS.needs },
    done: { frames: SHEPHERD_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: SHEPHERD_FRAMES.error, fps: 8, collar: MOOD_COLLARS.error },
  },
};
