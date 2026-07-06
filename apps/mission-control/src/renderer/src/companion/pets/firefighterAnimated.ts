import { FIREFIGHTER_FRAMES } from './firefighterFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/** Firefighter: PixelLab 92px frames per mood. */
export const firefighterAnimated: AnimatedPetSprite = {
  kind: 'firefighter',
  name: 'Firefighter',
  moods: {
    idle: { frames: FIREFIGHTER_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: FIREFIGHTER_FRAMES.working, fps: 10, collar: MOOD_COLLARS.working },
    needs: { frames: FIREFIGHTER_FRAMES.needs, fps: 6, collar: MOOD_COLLARS.needs },
    done: { frames: FIREFIGHTER_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: FIREFIGHTER_FRAMES.error, fps: 8, collar: MOOD_COLLARS.error },
  },
};
