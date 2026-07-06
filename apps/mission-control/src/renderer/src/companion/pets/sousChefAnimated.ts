import { SOUS_CHEF_FRAMES } from './sousChefFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/** Sous Chef: PixelLab 92px frames per mood. */
export const sousChefAnimated: AnimatedPetSprite = {
  kind: 'sous-chef',
  name: 'Sous Chef',
  moods: {
    idle: { frames: SOUS_CHEF_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: SOUS_CHEF_FRAMES.working, fps: 10, collar: MOOD_COLLARS.working },
    needs: { frames: SOUS_CHEF_FRAMES.needs, fps: 6, collar: MOOD_COLLARS.needs },
    done: { frames: SOUS_CHEF_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: SOUS_CHEF_FRAMES.error, fps: 8, collar: MOOD_COLLARS.error },
  },
};
