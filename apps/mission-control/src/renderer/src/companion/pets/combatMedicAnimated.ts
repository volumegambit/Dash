import { COMBAT_MEDIC_FRAMES } from './combatMedicFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/**
 * Animated combat medic: PixelLab-generated 92x92 bitmap frames per mood — breathing idle,
 * bandages a wound quickly while working, holds up a kit, waiting when a session needs you,
 * gives a reassuring thumbs-up on done, drops the medkit on error — plus the shared collar badge
 * hue per mood.
 */
export const combatMedicAnimated: AnimatedPetSprite = {
  kind: 'combat-medic',
  name: 'Combat Medic',
  moods: {
    idle: { frames: COMBAT_MEDIC_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: COMBAT_MEDIC_FRAMES.working, fps: 9, collar: MOOD_COLLARS.working },
    needs: { frames: COMBAT_MEDIC_FRAMES.needs, fps: 8, collar: MOOD_COLLARS.needs },
    done: { frames: COMBAT_MEDIC_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: COMBAT_MEDIC_FRAMES.error, fps: 8, collar: MOOD_COLLARS.error },
  },
};
