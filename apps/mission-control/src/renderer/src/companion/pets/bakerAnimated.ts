import { BAKER_FRAMES } from './bakerFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/** Baker: PixelLab 92px frames per mood. */
export const bakerAnimated: AnimatedPetSprite = {
  kind: 'baker',
  name: 'Baker',
  moods: {
    idle: { frames: BAKER_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: BAKER_FRAMES.working, fps: 10, collar: MOOD_COLLARS.working },
    needs: { frames: BAKER_FRAMES.needs, fps: 6, collar: MOOD_COLLARS.needs },
    done: { frames: BAKER_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: BAKER_FRAMES.error, fps: 8, collar: MOOD_COLLARS.error },
  },
};
