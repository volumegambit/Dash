import { FARMER_FRAMES } from './farmerFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/**
 * Animated farmer: PixelLab-generated 92x92 bitmap frames per mood — breathing idle, hoes a row
 * in the field while working, wipes brow on the hoe, waiting when a session needs you, holds up
 * a fresh harvest on done, the crop wilts on error — plus the shared collar badge hue per mood.
 */
export const farmerAnimated: AnimatedPetSprite = {
  kind: 'farmer',
  name: 'Farmer',
  moods: {
    idle: { frames: FARMER_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: FARMER_FRAMES.working, fps: 8, collar: MOOD_COLLARS.working },
    needs: { frames: FARMER_FRAMES.needs, fps: 7, collar: MOOD_COLLARS.needs },
    done: { frames: FARMER_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: FARMER_FRAMES.error, fps: 7, collar: MOOD_COLLARS.error },
  },
};
