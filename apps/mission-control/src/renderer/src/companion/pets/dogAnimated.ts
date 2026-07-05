import { DOG_FRAMES } from './dogFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/**
 * Animated dog: PixelLab-generated 92x92 bitmap frames per mood — calm idle,
 * running while working, barking when a session needs you, jumping excitedly
 * when done, growling on error — plus the shared collar badge hue per mood.
 */
export const dogAnimated: AnimatedPetSprite = {
  kind: 'dog',
  name: 'Dog',
  moods: {
    idle: { frames: DOG_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: DOG_FRAMES.working, fps: 10, collar: MOOD_COLLARS.working },
    needs: { frames: DOG_FRAMES.needs, fps: 7, collar: MOOD_COLLARS.needs },
    done: { frames: DOG_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: DOG_FRAMES.error, fps: 7, collar: MOOD_COLLARS.error },
  },
};
