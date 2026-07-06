import { SCARECROW_FRAMES } from './scarecrowFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/** Scarecrow: PixelLab 92px frames per mood. */
export const scarecrowAnimated: AnimatedPetSprite = {
  kind: 'scarecrow',
  name: 'Scarecrow',
  moods: {
    idle: { frames: SCARECROW_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: SCARECROW_FRAMES.working, fps: 10, collar: MOOD_COLLARS.working },
    needs: { frames: SCARECROW_FRAMES.needs, fps: 6, collar: MOOD_COLLARS.needs },
    done: { frames: SCARECROW_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: SCARECROW_FRAMES.error, fps: 8, collar: MOOD_COLLARS.error },
  },
};
