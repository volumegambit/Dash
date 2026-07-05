import { LION_FRAMES } from './lionFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/**
 * Animated lion: PixelLab-generated 92x92 bitmap frames per mood —
 * crowned idle, paces watchfully while working, roars when a session needs you, puffs its chest on done, swipes a paw on error — plus the shared collar badge hue per mood.
 */
export const lionAnimated: AnimatedPetSprite = {
  kind: 'lion',
  name: 'Lion',
  moods: {
    idle: { frames: LION_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: LION_FRAMES.working, fps: 8, collar: MOOD_COLLARS.working },
    needs: { frames: LION_FRAMES.needs, fps: 8, collar: MOOD_COLLARS.needs },
    done: { frames: LION_FRAMES.done, fps: 7, collar: MOOD_COLLARS.done },
    error: { frames: LION_FRAMES.error, fps: 9, collar: MOOD_COLLARS.error },
  },
};
