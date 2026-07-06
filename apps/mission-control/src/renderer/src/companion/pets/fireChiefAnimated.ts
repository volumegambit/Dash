import { FIRE_CHIEF_FRAMES } from './fireChiefFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/** Fire Chief: PixelLab 92px frames per mood. */
export const fireChiefAnimated: AnimatedPetSprite = {
  kind: 'fire-chief',
  name: 'Fire Chief',
  moods: {
    idle: { frames: FIRE_CHIEF_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: FIRE_CHIEF_FRAMES.working, fps: 10, collar: MOOD_COLLARS.working },
    needs: { frames: FIRE_CHIEF_FRAMES.needs, fps: 6, collar: MOOD_COLLARS.needs },
    done: { frames: FIRE_CHIEF_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: FIRE_CHIEF_FRAMES.error, fps: 8, collar: MOOD_COLLARS.error },
  },
};
