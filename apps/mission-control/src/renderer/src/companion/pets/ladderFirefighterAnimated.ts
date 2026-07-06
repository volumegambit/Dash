import { LADDER_FIREFIGHTER_FRAMES } from './ladderFirefighterFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/** Ladder Firefighter: PixelLab 92px frames per mood. */
export const ladderFirefighterAnimated: AnimatedPetSprite = {
  kind: 'ladder-firefighter',
  name: 'Ladder Firefighter',
  moods: {
    idle: { frames: LADDER_FIREFIGHTER_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: LADDER_FIREFIGHTER_FRAMES.working, fps: 10, collar: MOOD_COLLARS.working },
    needs: { frames: LADDER_FIREFIGHTER_FRAMES.needs, fps: 6, collar: MOOD_COLLARS.needs },
    done: { frames: LADDER_FIREFIGHTER_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: LADDER_FIREFIGHTER_FRAMES.error, fps: 8, collar: MOOD_COLLARS.error },
  },
};
