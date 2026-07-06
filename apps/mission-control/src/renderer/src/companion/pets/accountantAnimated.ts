import { ACCOUNTANT_FRAMES } from './accountantFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/** Accountant: PixelLab 92px frames per mood. */
export const accountantAnimated: AnimatedPetSprite = {
  kind: 'accountant',
  name: 'Accountant',
  moods: {
    idle: { frames: ACCOUNTANT_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: ACCOUNTANT_FRAMES.working, fps: 10, collar: MOOD_COLLARS.working },
    needs: { frames: ACCOUNTANT_FRAMES.needs, fps: 6, collar: MOOD_COLLARS.needs },
    done: { frames: ACCOUNTANT_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: ACCOUNTANT_FRAMES.error, fps: 8, collar: MOOD_COLLARS.error },
  },
};
