import { LADDER_FIREFIGHTER_FRAMES } from './ladderFirefighterFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/**
 * Animated ladder firefighter: PixelLab-generated 92x92 bitmap frames per mood — breathing idle,
 * climbs the ladder rung by rung while working, steadies the ladder, waiting when a session
 * needs you, reaches the top, rescue made on done, the ladder slips on error — plus the shared
 * collar badge hue per mood.
 */
export const ladderFirefighterAnimated: AnimatedPetSprite = {
  kind: 'ladder-firefighter',
  name: 'Ladder Firefighter',
  moods: {
    idle: { frames: LADDER_FIREFIGHTER_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: LADDER_FIREFIGHTER_FRAMES.working, fps: 9, collar: MOOD_COLLARS.working },
    needs: { frames: LADDER_FIREFIGHTER_FRAMES.needs, fps: 7, collar: MOOD_COLLARS.needs },
    done: { frames: LADDER_FIREFIGHTER_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: LADDER_FIREFIGHTER_FRAMES.error, fps: 8, collar: MOOD_COLLARS.error },
  },
};
