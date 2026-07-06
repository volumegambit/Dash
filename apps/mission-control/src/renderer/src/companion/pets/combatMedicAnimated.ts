import { COMBAT_MEDIC_FRAMES } from './combatMedicFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/** Combat Medic: PixelLab 92px frames per mood. */
export const combatMedicAnimated: AnimatedPetSprite = {
  kind: 'combat-medic',
  name: 'Combat Medic',
  moods: {
    idle: { frames: COMBAT_MEDIC_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: COMBAT_MEDIC_FRAMES.working, fps: 10, collar: MOOD_COLLARS.working },
    needs: { frames: COMBAT_MEDIC_FRAMES.needs, fps: 6, collar: MOOD_COLLARS.needs },
    done: { frames: COMBAT_MEDIC_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: COMBAT_MEDIC_FRAMES.error, fps: 8, collar: MOOD_COLLARS.error },
  },
};
