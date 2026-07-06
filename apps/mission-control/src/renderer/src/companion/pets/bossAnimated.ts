import { BOSS_FRAMES } from './bossFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/** Boss: PixelLab 92px frames per mood. */
export const bossAnimated: AnimatedPetSprite = {
  kind: 'boss',
  name: 'Boss',
  moods: {
    idle: { frames: BOSS_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: BOSS_FRAMES.working, fps: 10, collar: MOOD_COLLARS.working },
    needs: { frames: BOSS_FRAMES.needs, fps: 6, collar: MOOD_COLLARS.needs },
    done: { frames: BOSS_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: BOSS_FRAMES.error, fps: 8, collar: MOOD_COLLARS.error },
  },
};
