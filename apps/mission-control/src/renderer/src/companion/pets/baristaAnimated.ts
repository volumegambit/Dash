import { BARISTA_FRAMES } from './baristaFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/** Barista: PixelLab 92px frames per mood. */
export const baristaAnimated: AnimatedPetSprite = {
  kind: 'barista',
  name: 'Barista',
  moods: {
    idle: { frames: BARISTA_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: BARISTA_FRAMES.working, fps: 10, collar: MOOD_COLLARS.working },
    needs: { frames: BARISTA_FRAMES.needs, fps: 6, collar: MOOD_COLLARS.needs },
    done: { frames: BARISTA_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: BARISTA_FRAMES.error, fps: 8, collar: MOOD_COLLARS.error },
  },
};
