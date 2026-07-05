import { POLICE_OFFICER_FRAMES } from './policeOfficerFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/**
 * Animated police officer: PixelLab-generated 92x92 bitmap frames per mood — breathing idle,
 * directs traffic with a whistle while working, rests a hand on the belt, waiting when a session
 * needs you, tips the cap, case closed on done, the radio squawks trouble on error — plus the
 * shared collar badge hue per mood.
 */
export const policeOfficerAnimated: AnimatedPetSprite = {
  kind: 'police-officer',
  name: 'Police Officer',
  moods: {
    idle: { frames: POLICE_OFFICER_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: POLICE_OFFICER_FRAMES.working, fps: 9, collar: MOOD_COLLARS.working },
    needs: { frames: POLICE_OFFICER_FRAMES.needs, fps: 7, collar: MOOD_COLLARS.needs },
    done: { frames: POLICE_OFFICER_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: POLICE_OFFICER_FRAMES.error, fps: 8, collar: MOOD_COLLARS.error },
  },
};
