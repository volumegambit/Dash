import { SCOUT_FRAMES } from './scoutFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/** Scout: PixelLab 92px frames per mood. */
export const scoutAnimated: AnimatedPetSprite = {
  kind: 'scout',
  name: 'Scout',
  moods: {
    idle: { frames: SCOUT_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: SCOUT_FRAMES.working, fps: 10, collar: MOOD_COLLARS.working },
    needs: { frames: SCOUT_FRAMES.needs, fps: 6, collar: MOOD_COLLARS.needs },
    done: { frames: SCOUT_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: SCOUT_FRAMES.error, fps: 8, collar: MOOD_COLLARS.error },
  },
};
