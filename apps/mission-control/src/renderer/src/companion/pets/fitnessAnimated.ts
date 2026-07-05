import { FITNESS_FRAMES } from './fitnessFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/**
 * Animated fitness influencer: PixelLab-generated 92x92 bitmap frames per mood —
 * breathing idle, does bicep curls while working, points at you insistently when a session needs you, double-flexes on done, drops a dumbbell on its foot on error — plus the shared collar badge hue per mood.
 */
export const fitnessInfluencerAnimated: AnimatedPetSprite = {
  kind: 'fitness-influencer',
  name: 'Fitness Influencer',
  moods: {
    idle: { frames: FITNESS_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: FITNESS_FRAMES.working, fps: 9, collar: MOOD_COLLARS.working },
    needs: { frames: FITNESS_FRAMES.needs, fps: 7, collar: MOOD_COLLARS.needs },
    done: { frames: FITNESS_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: FITNESS_FRAMES.error, fps: 9, collar: MOOD_COLLARS.error },
  },
};
