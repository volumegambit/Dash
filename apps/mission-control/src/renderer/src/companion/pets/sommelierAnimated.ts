import { SOMMELIER_FRAMES } from './sommelierFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/** Sommelier: PixelLab 92px frames per mood. */
export const sommelierAnimated: AnimatedPetSprite = {
  kind: 'sommelier',
  name: 'Sommelier',
  moods: {
    idle: { frames: SOMMELIER_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: SOMMELIER_FRAMES.working, fps: 10, collar: MOOD_COLLARS.working },
    needs: { frames: SOMMELIER_FRAMES.needs, fps: 6, collar: MOOD_COLLARS.needs },
    done: { frames: SOMMELIER_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: SOMMELIER_FRAMES.error, fps: 8, collar: MOOD_COLLARS.error },
  },
};
