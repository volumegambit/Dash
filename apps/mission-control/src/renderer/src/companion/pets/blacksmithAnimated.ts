import { BLACKSMITH_FRAMES } from './blacksmithFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/** Blacksmith: PixelLab 92px frames per mood. */
export const blacksmithAnimated: AnimatedPetSprite = {
  kind: 'blacksmith',
  name: 'Blacksmith',
  moods: {
    idle: { frames: BLACKSMITH_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: BLACKSMITH_FRAMES.working, fps: 10, collar: MOOD_COLLARS.working },
    needs: { frames: BLACKSMITH_FRAMES.needs, fps: 6, collar: MOOD_COLLARS.needs },
    done: { frames: BLACKSMITH_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: BLACKSMITH_FRAMES.error, fps: 8, collar: MOOD_COLLARS.error },
  },
};
