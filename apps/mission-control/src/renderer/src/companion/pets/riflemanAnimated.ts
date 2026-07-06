import { RIFLEMAN_FRAMES } from './riflemanFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/** Rifleman: PixelLab 92px frames per mood. */
export const riflemanAnimated: AnimatedPetSprite = {
  kind: 'rifleman',
  name: 'Rifleman',
  moods: {
    idle: { frames: RIFLEMAN_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: RIFLEMAN_FRAMES.working, fps: 10, collar: MOOD_COLLARS.working },
    needs: { frames: RIFLEMAN_FRAMES.needs, fps: 6, collar: MOOD_COLLARS.needs },
    done: { frames: RIFLEMAN_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: RIFLEMAN_FRAMES.error, fps: 8, collar: MOOD_COLLARS.error },
  },
};
