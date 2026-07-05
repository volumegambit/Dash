import { DISHWASHER_FRAMES } from './dishwasherFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/**
 * Animated dishwasher: PixelLab-generated 92x92 bitmap frames per mood — breathing idle, scrubs
 * a stack of plates fast while working, drips over a full sink, waiting when a session needs
 * you, stacks the last clean plate on done, a plate slips and shatters on error — plus the
 * shared collar badge hue per mood.
 */
export const dishwasherAnimated: AnimatedPetSprite = {
  kind: 'dishwasher',
  name: 'Dishwasher',
  moods: {
    idle: { frames: DISHWASHER_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: DISHWASHER_FRAMES.working, fps: 10, collar: MOOD_COLLARS.working },
    needs: { frames: DISHWASHER_FRAMES.needs, fps: 7, collar: MOOD_COLLARS.needs },
    done: { frames: DISHWASHER_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: DISHWASHER_FRAMES.error, fps: 8, collar: MOOD_COLLARS.error },
  },
};
