import { POLICE_OFFICER_FRAMES } from './policeOfficerFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/** Police Officer: PixelLab 92px frames per mood. */
export const policeOfficerAnimated: AnimatedPetSprite = {
  kind: 'police-officer',
  name: 'Police Officer',
  moods: {
    idle: { frames: POLICE_OFFICER_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: POLICE_OFFICER_FRAMES.working, fps: 10, collar: MOOD_COLLARS.working },
    needs: { frames: POLICE_OFFICER_FRAMES.needs, fps: 6, collar: MOOD_COLLARS.needs },
    done: { frames: POLICE_OFFICER_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: POLICE_OFFICER_FRAMES.error, fps: 8, collar: MOOD_COLLARS.error },
  },
};
