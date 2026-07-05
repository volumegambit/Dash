import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';
import { UNICORN_FRAMES } from './unicornFrames.js';

/**
 * Animated unicorn: PixelLab-generated 92x92 bitmap frames per mood —
 * shakes its mane while idle, prances with sparkles while working, paws the ground when a session needs you, rears up joyfully on done, stomps and tosses its mane on error — plus the shared collar badge hue per mood.
 */
export const unicornAnimated: AnimatedPetSprite = {
  kind: 'unicorn',
  name: 'Unicorn',
  moods: {
    idle: { frames: UNICORN_FRAMES.idle, fps: 6, collar: MOOD_COLLARS.idle },
    working: { frames: UNICORN_FRAMES.working, fps: 9, collar: MOOD_COLLARS.working },
    needs: { frames: UNICORN_FRAMES.needs, fps: 6, collar: MOOD_COLLARS.needs },
    done: { frames: UNICORN_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: UNICORN_FRAMES.error, fps: 8, collar: MOOD_COLLARS.error },
  },
};
