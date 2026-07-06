import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';
import { WALL_BALLER_FRAMES } from './wallBallerFrames.js';

/** Wall Baller: PixelLab 92px frames per mood. */
export const wallBallerAnimated: AnimatedPetSprite = {
  kind: 'wall-baller',
  name: 'Wall Baller',
  moods: {
    idle: { frames: WALL_BALLER_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: WALL_BALLER_FRAMES.working, fps: 10, collar: MOOD_COLLARS.working },
    needs: { frames: WALL_BALLER_FRAMES.needs, fps: 6, collar: MOOD_COLLARS.needs },
    done: { frames: WALL_BALLER_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: WALL_BALLER_FRAMES.error, fps: 8, collar: MOOD_COLLARS.error },
  },
};
