import { PASTRY_CHEF_FRAMES } from './pastryChefFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/**
 * Animated pastry chef: PixelLab-generated 92x92 bitmap frames per mood — breathing idle, pipes
 * icing onto a cake while working, dusts flour off its hands, waiting when a session needs you,
 * presents a finished pastry on done, a soufflé collapses on error — plus the shared collar
 * badge hue per mood.
 */
export const pastryChefAnimated: AnimatedPetSprite = {
  kind: 'pastry-chef',
  name: 'Pastry Chef',
  moods: {
    idle: { frames: PASTRY_CHEF_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: PASTRY_CHEF_FRAMES.working, fps: 9, collar: MOOD_COLLARS.working },
    needs: { frames: PASTRY_CHEF_FRAMES.needs, fps: 7, collar: MOOD_COLLARS.needs },
    done: { frames: PASTRY_CHEF_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: PASTRY_CHEF_FRAMES.error, fps: 8, collar: MOOD_COLLARS.error },
  },
};
