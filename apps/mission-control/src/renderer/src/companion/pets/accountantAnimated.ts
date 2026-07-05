import { ACCOUNTANT_FRAMES } from './accountantFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/**
 * Animated accountant: PixelLab-generated 92x92 bitmap frames per mood — breathing idle, taps
 * away on a calculator while working, adjusts glasses, waiting when a session needs you, stamps
 * the ledger — balanced on done, the numbers do not add up on error — plus the shared collar
 * badge hue per mood.
 */
export const accountantAnimated: AnimatedPetSprite = {
  kind: 'accountant',
  name: 'Accountant',
  moods: {
    idle: { frames: ACCOUNTANT_FRAMES.idle, fps: 4, collar: MOOD_COLLARS.idle },
    working: { frames: ACCOUNTANT_FRAMES.working, fps: 9, collar: MOOD_COLLARS.working },
    needs: { frames: ACCOUNTANT_FRAMES.needs, fps: 7, collar: MOOD_COLLARS.needs },
    done: { frames: ACCOUNTANT_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: ACCOUNTANT_FRAMES.error, fps: 8, collar: MOOD_COLLARS.error },
  },
};
