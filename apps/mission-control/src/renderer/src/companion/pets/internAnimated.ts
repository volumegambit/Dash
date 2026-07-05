import { INTERN_FRAMES } from './internFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/**
 * Animated intern: PixelLab-generated 92x92 bitmap frames per mood — breathing idle, juggles
 * coffee cups eagerly while working, raises a hand with a question when a session needs you,
 * beams after nailing the task on done, spills the whole coffee tray on error — plus the shared
 * collar badge hue per mood.
 */
export const internAnimated: AnimatedPetSprite = {
  kind: 'intern',
  name: 'Intern',
  moods: {
    idle: { frames: INTERN_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: INTERN_FRAMES.working, fps: 10, collar: MOOD_COLLARS.working },
    needs: { frames: INTERN_FRAMES.needs, fps: 8, collar: MOOD_COLLARS.needs },
    done: { frames: INTERN_FRAMES.done, fps: 9, collar: MOOD_COLLARS.done },
    error: { frames: INTERN_FRAMES.error, fps: 8, collar: MOOD_COLLARS.error },
  },
};
