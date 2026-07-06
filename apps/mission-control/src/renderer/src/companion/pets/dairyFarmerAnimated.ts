import { DAIRY_FARMER_FRAMES } from './dairyFarmerFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/** Dairy Farmer: PixelLab 92px frames per mood. */
export const dairyFarmerAnimated: AnimatedPetSprite = {
  kind: 'dairy-farmer',
  name: 'Dairy Farmer',
  moods: {
    idle: { frames: DAIRY_FARMER_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: DAIRY_FARMER_FRAMES.working, fps: 10, collar: MOOD_COLLARS.working },
    needs: { frames: DAIRY_FARMER_FRAMES.needs, fps: 6, collar: MOOD_COLLARS.needs },
    done: { frames: DAIRY_FARMER_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: DAIRY_FARMER_FRAMES.error, fps: 8, collar: MOOD_COLLARS.error },
  },
};
