import { PASTRY_CHEF_FRAMES } from './pastryChefFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/** Pastry Chef: PixelLab 92px frames per mood. */
export const pastryChefAnimated: AnimatedPetSprite = {
  kind: 'pastry-chef',
  name: 'Pastry Chef',
  moods: {
    idle: { frames: PASTRY_CHEF_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: PASTRY_CHEF_FRAMES.working, fps: 10, collar: MOOD_COLLARS.working },
    needs: { frames: PASTRY_CHEF_FRAMES.needs, fps: 6, collar: MOOD_COLLARS.needs },
    done: { frames: PASTRY_CHEF_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: PASTRY_CHEF_FRAMES.error, fps: 8, collar: MOOD_COLLARS.error },
  },
};
