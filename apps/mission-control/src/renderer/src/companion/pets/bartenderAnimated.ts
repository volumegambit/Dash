import { BARTENDER_FRAMES } from './bartenderFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/** Bartender: PixelLab 92px frames per mood. */
export const bartenderAnimated: AnimatedPetSprite = {
  kind: 'bartender',
  name: 'Bartender',
  moods: {
    idle: { frames: BARTENDER_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: BARTENDER_FRAMES.working, fps: 10, collar: MOOD_COLLARS.working },
    needs: { frames: BARTENDER_FRAMES.needs, fps: 6, collar: MOOD_COLLARS.needs },
    done: { frames: BARTENDER_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: BARTENDER_FRAMES.error, fps: 8, collar: MOOD_COLLARS.error },
  },
};
