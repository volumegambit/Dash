import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';
import { WAITER_FRAMES } from './waiterFrames.js';

/** Waiter: PixelLab 92px frames per mood. */
export const waiterAnimated: AnimatedPetSprite = {
  kind: 'waiter',
  name: 'Waiter',
  moods: {
    idle: { frames: WAITER_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: WAITER_FRAMES.working, fps: 10, collar: MOOD_COLLARS.working },
    needs: { frames: WAITER_FRAMES.needs, fps: 6, collar: MOOD_COLLARS.needs },
    done: { frames: WAITER_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: WAITER_FRAMES.error, fps: 8, collar: MOOD_COLLARS.error },
  },
};
