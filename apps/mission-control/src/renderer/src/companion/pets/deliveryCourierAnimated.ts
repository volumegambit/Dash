import { DELIVERY_COURIER_FRAMES } from './deliveryCourierFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/** Delivery Courier: PixelLab 92px frames per mood. */
export const deliveryCourierAnimated: AnimatedPetSprite = {
  kind: 'delivery-courier',
  name: 'Delivery Courier',
  moods: {
    idle: { frames: DELIVERY_COURIER_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: DELIVERY_COURIER_FRAMES.working, fps: 10, collar: MOOD_COLLARS.working },
    needs: { frames: DELIVERY_COURIER_FRAMES.needs, fps: 6, collar: MOOD_COLLARS.needs },
    done: { frames: DELIVERY_COURIER_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: DELIVERY_COURIER_FRAMES.error, fps: 8, collar: MOOD_COLLARS.error },
  },
};
