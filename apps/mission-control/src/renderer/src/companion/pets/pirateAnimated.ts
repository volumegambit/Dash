import { PIRATE_FRAMES } from './pirateFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/**
 * Animated pirate: PixelLab-generated 92x92 bitmap frames per mood —
 * breathing idle, digs for treasure while working, scans with a spyglass when a session needs you, hoists the treasure chest on done, stomps and shakes a fist on error — plus the shared collar badge hue per mood.
 */
export const pirateAnimated: AnimatedPetSprite = {
  kind: 'pirate',
  name: 'Pirate',
  moods: {
    idle: { frames: PIRATE_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: PIRATE_FRAMES.working, fps: 9, collar: MOOD_COLLARS.working },
    needs: { frames: PIRATE_FRAMES.needs, fps: 6, collar: MOOD_COLLARS.needs },
    done: { frames: PIRATE_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: PIRATE_FRAMES.error, fps: 8, collar: MOOD_COLLARS.error },
  },
};
