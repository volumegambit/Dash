import { SCOUT_FRAMES } from './scoutFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/**
 * Animated scout: PixelLab-generated 92x92 bitmap frames per mood — breathing idle, creeps ahead
 * scanning the terrain while working, crouches, signalling to wait when a session needs you,
 * gives the all-clear hand sign on done, trips a snare on error — plus the shared collar badge
 * hue per mood.
 */
export const scoutAnimated: AnimatedPetSprite = {
  kind: 'scout',
  name: 'Scout',
  moods: {
    idle: { frames: SCOUT_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: SCOUT_FRAMES.working, fps: 10, collar: MOOD_COLLARS.working },
    needs: { frames: SCOUT_FRAMES.needs, fps: 7, collar: MOOD_COLLARS.needs },
    done: { frames: SCOUT_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: SCOUT_FRAMES.error, fps: 8, collar: MOOD_COLLARS.error },
  },
};
