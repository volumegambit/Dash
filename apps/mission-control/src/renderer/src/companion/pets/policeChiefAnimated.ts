import { POLICE_CHIEF_FRAMES } from './policeChiefFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/**
 * Animated police chief: PixelLab-generated 92x92 bitmap frames per mood — breathing idle,
 * briefs the room at the board while working, folds arms, waiting on you when a session needs
 * you, pins a badge, commended on done, slams the desk in anger on error — plus the shared
 * collar badge hue per mood.
 */
export const policeChiefAnimated: AnimatedPetSprite = {
  kind: 'police-chief',
  name: 'Police Chief',
  moods: {
    idle: { frames: POLICE_CHIEF_FRAMES.idle, fps: 4, collar: MOOD_COLLARS.idle },
    working: { frames: POLICE_CHIEF_FRAMES.working, fps: 8, collar: MOOD_COLLARS.working },
    needs: { frames: POLICE_CHIEF_FRAMES.needs, fps: 7, collar: MOOD_COLLARS.needs },
    done: { frames: POLICE_CHIEF_FRAMES.done, fps: 9, collar: MOOD_COLLARS.done },
    error: { frames: POLICE_CHIEF_FRAMES.error, fps: 8, collar: MOOD_COLLARS.error },
  },
};
