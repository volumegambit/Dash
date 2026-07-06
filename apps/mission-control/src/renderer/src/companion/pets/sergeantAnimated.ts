import { SERGEANT_FRAMES } from './sergeantFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/** Sergeant: PixelLab 92px frames per mood. */
export const sergeantAnimated: AnimatedPetSprite = {
  kind: 'sergeant',
  name: 'Sergeant',
  moods: {
    idle: { frames: SERGEANT_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: SERGEANT_FRAMES.working, fps: 10, collar: MOOD_COLLARS.working },
    needs: { frames: SERGEANT_FRAMES.needs, fps: 6, collar: MOOD_COLLARS.needs },
    done: { frames: SERGEANT_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: SERGEANT_FRAMES.error, fps: 8, collar: MOOD_COLLARS.error },
  },
};
