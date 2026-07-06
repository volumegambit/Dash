import { SLED_PUSHER_FRAMES } from './sledPusherFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/** Sled Pusher: PixelLab 92px frames per mood. */
export const sledPusherAnimated: AnimatedPetSprite = {
  kind: 'sled-pusher',
  name: 'Sled Pusher',
  moods: {
    idle: { frames: SLED_PUSHER_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: SLED_PUSHER_FRAMES.working, fps: 10, collar: MOOD_COLLARS.working },
    needs: { frames: SLED_PUSHER_FRAMES.needs, fps: 6, collar: MOOD_COLLARS.needs },
    done: { frames: SLED_PUSHER_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: SLED_PUSHER_FRAMES.error, fps: 8, collar: MOOD_COLLARS.error },
  },
};
