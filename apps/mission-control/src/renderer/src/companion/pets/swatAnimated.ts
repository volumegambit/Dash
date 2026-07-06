import { SWAT_FRAMES } from './swatFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/** SWAT: PixelLab 92px frames per mood. */
export const swatAnimated: AnimatedPetSprite = {
  kind: 'swat',
  name: 'SWAT',
  moods: {
    idle: { frames: SWAT_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: SWAT_FRAMES.working, fps: 10, collar: MOOD_COLLARS.working },
    needs: { frames: SWAT_FRAMES.needs, fps: 6, collar: MOOD_COLLARS.needs },
    done: { frames: SWAT_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: SWAT_FRAMES.error, fps: 8, collar: MOOD_COLLARS.error },
  },
};
