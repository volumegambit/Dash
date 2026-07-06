import { BUTCHER_FRAMES } from './butcherFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/** Butcher: PixelLab 92px frames per mood. */
export const butcherAnimated: AnimatedPetSprite = {
  kind: 'butcher',
  name: 'Butcher',
  moods: {
    idle: { frames: BUTCHER_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: BUTCHER_FRAMES.working, fps: 10, collar: MOOD_COLLARS.working },
    needs: { frames: BUTCHER_FRAMES.needs, fps: 6, collar: MOOD_COLLARS.needs },
    done: { frames: BUTCHER_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: BUTCHER_FRAMES.error, fps: 8, collar: MOOD_COLLARS.error },
  },
};
