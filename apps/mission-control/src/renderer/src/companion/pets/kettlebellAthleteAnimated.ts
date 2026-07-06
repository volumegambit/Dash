import { KETTLEBELL_ATHLETE_FRAMES } from './kettlebellAthleteFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/** Kettlebell Athlete: PixelLab 92px frames per mood. */
export const kettlebellAthleteAnimated: AnimatedPetSprite = {
  kind: 'kettlebell-athlete',
  name: 'Kettlebell Athlete',
  moods: {
    idle: { frames: KETTLEBELL_ATHLETE_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: KETTLEBELL_ATHLETE_FRAMES.working, fps: 10, collar: MOOD_COLLARS.working },
    needs: { frames: KETTLEBELL_ATHLETE_FRAMES.needs, fps: 6, collar: MOOD_COLLARS.needs },
    done: { frames: KETTLEBELL_ATHLETE_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: KETTLEBELL_ATHLETE_FRAMES.error, fps: 8, collar: MOOD_COLLARS.error },
  },
};
