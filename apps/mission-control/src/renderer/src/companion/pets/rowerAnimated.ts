import { ROWER_FRAMES } from './rowerFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/** Rower: PixelLab 92px frames per mood. */
export const rowerAnimated: AnimatedPetSprite = {
  kind: 'rower',
  name: 'Rower',
  moods: {
    idle: { frames: ROWER_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: ROWER_FRAMES.working, fps: 10, collar: MOOD_COLLARS.working },
    needs: { frames: ROWER_FRAMES.needs, fps: 6, collar: MOOD_COLLARS.needs },
    done: { frames: ROWER_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: ROWER_FRAMES.error, fps: 8, collar: MOOD_COLLARS.error },
  },
};
