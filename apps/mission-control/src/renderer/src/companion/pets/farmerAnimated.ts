import { FARMER_FRAMES } from './farmerFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/** Farmer: PixelLab 92px frames per mood. */
export const farmerAnimated: AnimatedPetSprite = {
  kind: 'farmer',
  name: 'Farmer',
  moods: {
    idle: { frames: FARMER_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: FARMER_FRAMES.working, fps: 10, collar: MOOD_COLLARS.working },
    needs: { frames: FARMER_FRAMES.needs, fps: 6, collar: MOOD_COLLARS.needs },
    done: { frames: FARMER_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: FARMER_FRAMES.error, fps: 8, collar: MOOD_COLLARS.error },
  },
};
