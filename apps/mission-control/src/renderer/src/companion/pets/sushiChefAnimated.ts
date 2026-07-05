import { SUSHI_CHEF_FRAMES } from './sushiChefFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/**
 * Animated sushi chef: PixelLab-generated 92x92 bitmap frames per mood — breathing idle, slices
 * fish with a steady knife while working, wipes the board and waits when a session needs you,
 * sets down a perfect nigiri on done, fumbles a roll on error — plus the shared collar badge hue
 * per mood.
 */
export const sushiChefAnimated: AnimatedPetSprite = {
  kind: 'sushi-chef',
  name: 'Sushi Chef',
  moods: {
    idle: { frames: SUSHI_CHEF_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: SUSHI_CHEF_FRAMES.working, fps: 9, collar: MOOD_COLLARS.working },
    needs: { frames: SUSHI_CHEF_FRAMES.needs, fps: 7, collar: MOOD_COLLARS.needs },
    done: { frames: SUSHI_CHEF_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: SUSHI_CHEF_FRAMES.error, fps: 8, collar: MOOD_COLLARS.error },
  },
};
