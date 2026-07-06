import { MOTORCYCLE_COP_FRAMES } from './motorcycleCopFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/** Motorcycle Cop: PixelLab 92px frames per mood. */
export const motorcycleCopAnimated: AnimatedPetSprite = {
  kind: 'motorcycle-cop',
  name: 'Motorcycle Cop',
  moods: {
    idle: { frames: MOTORCYCLE_COP_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: MOTORCYCLE_COP_FRAMES.working, fps: 10, collar: MOOD_COLLARS.working },
    needs: { frames: MOTORCYCLE_COP_FRAMES.needs, fps: 6, collar: MOOD_COLLARS.needs },
    done: { frames: MOTORCYCLE_COP_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: MOTORCYCLE_COP_FRAMES.error, fps: 8, collar: MOOD_COLLARS.error },
  },
};
