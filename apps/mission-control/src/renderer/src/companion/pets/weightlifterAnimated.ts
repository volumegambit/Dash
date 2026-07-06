import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';
import { WEIGHTLIFTER_FRAMES } from './weightlifterFrames.js';

/** Weightlifter: PixelLab 92px frames per mood. */
export const weightlifterAnimated: AnimatedPetSprite = {
  kind: 'weightlifter',
  name: 'Weightlifter',
  moods: {
    idle: { frames: WEIGHTLIFTER_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: WEIGHTLIFTER_FRAMES.working, fps: 10, collar: MOOD_COLLARS.working },
    needs: { frames: WEIGHTLIFTER_FRAMES.needs, fps: 6, collar: MOOD_COLLARS.needs },
    done: { frames: WEIGHTLIFTER_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: WEIGHTLIFTER_FRAMES.error, fps: 8, collar: MOOD_COLLARS.error },
  },
};
