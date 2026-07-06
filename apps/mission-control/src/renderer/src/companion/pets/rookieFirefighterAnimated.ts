import { ROOKIE_FIREFIGHTER_FRAMES } from './rookieFirefighterFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/** Rookie Firefighter: PixelLab 92px frames per mood. */
export const rookieFirefighterAnimated: AnimatedPetSprite = {
  kind: 'rookie-firefighter',
  name: 'Rookie Firefighter',
  moods: {
    idle: { frames: ROOKIE_FIREFIGHTER_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: ROOKIE_FIREFIGHTER_FRAMES.working, fps: 10, collar: MOOD_COLLARS.working },
    needs: { frames: ROOKIE_FIREFIGHTER_FRAMES.needs, fps: 6, collar: MOOD_COLLARS.needs },
    done: { frames: ROOKIE_FIREFIGHTER_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: ROOKIE_FIREFIGHTER_FRAMES.error, fps: 8, collar: MOOD_COLLARS.error },
  },
};
