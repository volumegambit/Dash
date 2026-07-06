import { IT_SUPPORT_FRAMES } from './itSupportFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/** IT Support: PixelLab 92px frames per mood. */
export const itSupportAnimated: AnimatedPetSprite = {
  kind: 'it-support',
  name: 'IT Support',
  moods: {
    idle: { frames: IT_SUPPORT_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: IT_SUPPORT_FRAMES.working, fps: 10, collar: MOOD_COLLARS.working },
    needs: { frames: IT_SUPPORT_FRAMES.needs, fps: 6, collar: MOOD_COLLARS.needs },
    done: { frames: IT_SUPPORT_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: IT_SUPPORT_FRAMES.error, fps: 8, collar: MOOD_COLLARS.error },
  },
};
