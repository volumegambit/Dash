import { SHEPHERD_FRAMES } from './shepherdFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/**
 * Animated shepherd: PixelLab-generated 92x92 bitmap frames per mood — breathing idle, guides
 * the sheep along while working, leans on the crook, waiting when a session needs you, pens the
 * flock safely on done, a sheep wanders off on error — plus the shared collar badge hue per
 * mood.
 */
export const shepherdAnimated: AnimatedPetSprite = {
  kind: 'shepherd',
  name: 'Shepherd',
  moods: {
    idle: { frames: SHEPHERD_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: SHEPHERD_FRAMES.working, fps: 8, collar: MOOD_COLLARS.working },
    needs: { frames: SHEPHERD_FRAMES.needs, fps: 7, collar: MOOD_COLLARS.needs },
    done: { frames: SHEPHERD_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: SHEPHERD_FRAMES.error, fps: 7, collar: MOOD_COLLARS.error },
  },
};
