import { GENERAL_FRAMES } from './generalFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/**
 * Animated general: PixelLab-generated 92x92 bitmap frames per mood — breathing idle, points
 * across a battle map while working, stands, hands clasped, waiting when a session needs you,
 * pins on a medal, victorious on done, sweeps the pieces off the map on error — plus the shared
 * collar badge hue per mood.
 */
export const generalAnimated: AnimatedPetSprite = {
  kind: 'general',
  name: 'General',
  moods: {
    idle: { frames: GENERAL_FRAMES.idle, fps: 4, collar: MOOD_COLLARS.idle },
    working: { frames: GENERAL_FRAMES.working, fps: 8, collar: MOOD_COLLARS.working },
    needs: { frames: GENERAL_FRAMES.needs, fps: 6, collar: MOOD_COLLARS.needs },
    done: { frames: GENERAL_FRAMES.done, fps: 9, collar: MOOD_COLLARS.done },
    error: { frames: GENERAL_FRAMES.error, fps: 8, collar: MOOD_COLLARS.error },
  },
};
