import { NINJA_FRAMES } from './ninjaFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/**
 * Animated ninja: PixelLab-generated 92x92 bitmap frames per mood —
 * fight-stance idle, trains with cross punches while working, crouches in wait when a session needs you, front-flips on done, slashes angrily on error — plus the shared collar badge hue per mood.
 */
export const ninjaAnimated: AnimatedPetSprite = {
  kind: 'ninja',
  name: 'Ninja',
  moods: {
    idle: { frames: NINJA_FRAMES.idle, fps: 6, collar: MOOD_COLLARS.idle },
    working: { frames: NINJA_FRAMES.working, fps: 10, collar: MOOD_COLLARS.working },
    needs: { frames: NINJA_FRAMES.needs, fps: 4, collar: MOOD_COLLARS.needs },
    done: { frames: NINJA_FRAMES.done, fps: 10, collar: MOOD_COLLARS.done },
    error: { frames: NINJA_FRAMES.error, fps: 10, collar: MOOD_COLLARS.error },
  },
};
