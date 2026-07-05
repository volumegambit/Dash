import { FIREFIGHTER_FRAMES } from './firefighterFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/**
 * Animated firefighter: PixelLab-generated 92x92 bitmap frames per mood — breathing idle, aims
 * the hose at the blaze while working, grips the nozzle, waiting when a session needs you, wipes
 * brow — fire is out on done, the hose whips loose on error — plus the shared collar badge hue
 * per mood.
 */
export const firefighterAnimated: AnimatedPetSprite = {
  kind: 'firefighter',
  name: 'Firefighter',
  moods: {
    idle: { frames: FIREFIGHTER_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: FIREFIGHTER_FRAMES.working, fps: 10, collar: MOOD_COLLARS.working },
    needs: { frames: FIREFIGHTER_FRAMES.needs, fps: 7, collar: MOOD_COLLARS.needs },
    done: { frames: FIREFIGHTER_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: FIREFIGHTER_FRAMES.error, fps: 9, collar: MOOD_COLLARS.error },
  },
};
