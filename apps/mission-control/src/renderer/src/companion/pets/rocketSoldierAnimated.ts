import { ROCKET_SOLDIER_FRAMES } from './rocketSoldierFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/** Rocket Soldier: PixelLab 92px frames per mood. */
export const rocketSoldierAnimated: AnimatedPetSprite = {
  kind: 'rocket-soldier',
  name: 'Rocket Soldier',
  moods: {
    idle: { frames: ROCKET_SOLDIER_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: ROCKET_SOLDIER_FRAMES.working, fps: 10, collar: MOOD_COLLARS.working },
    needs: { frames: ROCKET_SOLDIER_FRAMES.needs, fps: 6, collar: MOOD_COLLARS.needs },
    done: { frames: ROCKET_SOLDIER_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: ROCKET_SOLDIER_FRAMES.error, fps: 8, collar: MOOD_COLLARS.error },
  },
};
