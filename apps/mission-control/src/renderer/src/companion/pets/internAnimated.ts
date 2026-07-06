import { INTERN_FRAMES } from './internFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/** Intern: PixelLab 92px frames per mood. */
export const internAnimated: AnimatedPetSprite = {
  kind: 'intern',
  name: 'Intern',
  moods: {
    idle: { frames: INTERN_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: INTERN_FRAMES.working, fps: 10, collar: MOOD_COLLARS.working },
    needs: { frames: INTERN_FRAMES.needs, fps: 6, collar: MOOD_COLLARS.needs },
    done: { frames: INTERN_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: INTERN_FRAMES.error, fps: 8, collar: MOOD_COLLARS.error },
  },
};
