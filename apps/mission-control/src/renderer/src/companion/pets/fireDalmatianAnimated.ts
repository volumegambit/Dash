import { FIRE_DALMATIAN_FRAMES } from './fireDalmatianFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/** Fire Dalmatian: PixelLab 92px frames per mood. */
export const fireDalmatianAnimated: AnimatedPetSprite = {
  kind: 'fire-dalmatian',
  name: 'Fire Dalmatian',
  moods: {
    idle: { frames: FIRE_DALMATIAN_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: FIRE_DALMATIAN_FRAMES.working, fps: 10, collar: MOOD_COLLARS.working },
    needs: { frames: FIRE_DALMATIAN_FRAMES.needs, fps: 6, collar: MOOD_COLLARS.needs },
    done: { frames: FIRE_DALMATIAN_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: FIRE_DALMATIAN_FRAMES.error, fps: 8, collar: MOOD_COLLARS.error },
  },
};
