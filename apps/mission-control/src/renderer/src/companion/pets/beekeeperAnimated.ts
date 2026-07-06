import { BEEKEEPER_FRAMES } from './beekeeperFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/** Beekeeper: PixelLab 92px frames per mood. */
export const beekeeperAnimated: AnimatedPetSprite = {
  kind: 'beekeeper',
  name: 'Beekeeper',
  moods: {
    idle: { frames: BEEKEEPER_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: BEEKEEPER_FRAMES.working, fps: 10, collar: MOOD_COLLARS.working },
    needs: { frames: BEEKEEPER_FRAMES.needs, fps: 6, collar: MOOD_COLLARS.needs },
    done: { frames: BEEKEEPER_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: BEEKEEPER_FRAMES.error, fps: 8, collar: MOOD_COLLARS.error },
  },
};
