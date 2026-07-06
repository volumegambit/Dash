import { RECEPTIONIST_FRAMES } from './receptionistFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/** Receptionist: PixelLab 92px frames per mood. */
export const receptionistAnimated: AnimatedPetSprite = {
  kind: 'receptionist',
  name: 'Receptionist',
  moods: {
    idle: { frames: RECEPTIONIST_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: RECEPTIONIST_FRAMES.working, fps: 10, collar: MOOD_COLLARS.working },
    needs: { frames: RECEPTIONIST_FRAMES.needs, fps: 6, collar: MOOD_COLLARS.needs },
    done: { frames: RECEPTIONIST_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: RECEPTIONIST_FRAMES.error, fps: 8, collar: MOOD_COLLARS.error },
  },
};
