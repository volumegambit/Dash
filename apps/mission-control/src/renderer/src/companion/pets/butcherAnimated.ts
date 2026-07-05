import { BUTCHER_FRAMES } from './butcherFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/**
 * Animated butcher: PixelLab-generated 92x92 bitmap frames per mood — breathing idle, chops on
 * the block with a cleaver while working, sharpens the blade, waiting when a session needs you,
 * hangs a finished cut with pride on done, the cleaver sticks fast on error — plus the shared
 * collar badge hue per mood.
 */
export const butcherAnimated: AnimatedPetSprite = {
  kind: 'butcher',
  name: 'Butcher',
  moods: {
    idle: { frames: BUTCHER_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: BUTCHER_FRAMES.working, fps: 8, collar: MOOD_COLLARS.working },
    needs: { frames: BUTCHER_FRAMES.needs, fps: 7, collar: MOOD_COLLARS.needs },
    done: { frames: BUTCHER_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: BUTCHER_FRAMES.error, fps: 8, collar: MOOD_COLLARS.error },
  },
};
