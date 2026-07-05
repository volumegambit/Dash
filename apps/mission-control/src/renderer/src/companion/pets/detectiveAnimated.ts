import { DETECTIVE_FRAMES } from './detectiveFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/**
 * Animated detective: PixelLab-generated 92x92 bitmap frames per mood — breathing idle, inspects
 * a clue with a lens while working, taps a notepad, waiting when a session needs you, snaps
 * fingers — solved it on done, the trail goes cold on error — plus the shared collar badge hue
 * per mood.
 */
export const detectiveAnimated: AnimatedPetSprite = {
  kind: 'detective',
  name: 'Detective',
  moods: {
    idle: { frames: DETECTIVE_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: DETECTIVE_FRAMES.working, fps: 8, collar: MOOD_COLLARS.working },
    needs: { frames: DETECTIVE_FRAMES.needs, fps: 7, collar: MOOD_COLLARS.needs },
    done: { frames: DETECTIVE_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: DETECTIVE_FRAMES.error, fps: 8, collar: MOOD_COLLARS.error },
  },
};
