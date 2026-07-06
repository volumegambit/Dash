import { SUSHI_CHEF_FRAMES } from './sushiChefFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/** Sushi Chef: PixelLab 92px frames per mood. */
export const sushiChefAnimated: AnimatedPetSprite = {
  kind: 'sushi-chef',
  name: 'Sushi Chef',
  moods: {
    idle: { frames: SUSHI_CHEF_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: SUSHI_CHEF_FRAMES.working, fps: 10, collar: MOOD_COLLARS.working },
    needs: { frames: SUSHI_CHEF_FRAMES.needs, fps: 6, collar: MOOD_COLLARS.needs },
    done: { frames: SUSHI_CHEF_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: SUSHI_CHEF_FRAMES.error, fps: 8, collar: MOOD_COLLARS.error },
  },
};
