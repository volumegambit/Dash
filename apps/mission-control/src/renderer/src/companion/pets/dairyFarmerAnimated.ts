import { DAIRY_FARMER_FRAMES } from './dairyFarmerFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/**
 * Animated dairy farmer: PixelLab-generated 92x92 bitmap frames per mood — breathing idle,
 * carries a yoke of milk pails while working, sets down a pail, waiting when a session needs
 * you, hefts a full pail, done on done, a pail tips and spills on error — plus the shared collar
 * badge hue per mood.
 */
export const dairyFarmerAnimated: AnimatedPetSprite = {
  kind: 'dairy-farmer',
  name: 'Dairy Farmer',
  moods: {
    idle: { frames: DAIRY_FARMER_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: DAIRY_FARMER_FRAMES.working, fps: 8, collar: MOOD_COLLARS.working },
    needs: { frames: DAIRY_FARMER_FRAMES.needs, fps: 7, collar: MOOD_COLLARS.needs },
    done: { frames: DAIRY_FARMER_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: DAIRY_FARMER_FRAMES.error, fps: 7, collar: MOOD_COLLARS.error },
  },
};
