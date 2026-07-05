import { TOWN_CRIER_FRAMES } from './townCrierFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/**
 * Animated town crier: PixelLab-generated 92x92 bitmap frames per mood — breathing idle, rings
 * the bell and calls out while working, unrolls a scroll, waiting when a session needs you, bows
 * after the proclamation on done, the scroll tears mid-cry on error — plus the shared collar
 * badge hue per mood.
 */
export const townCrierAnimated: AnimatedPetSprite = {
  kind: 'town-crier',
  name: 'Town Crier',
  moods: {
    idle: { frames: TOWN_CRIER_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: TOWN_CRIER_FRAMES.working, fps: 9, collar: MOOD_COLLARS.working },
    needs: { frames: TOWN_CRIER_FRAMES.needs, fps: 8, collar: MOOD_COLLARS.needs },
    done: { frames: TOWN_CRIER_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: TOWN_CRIER_FRAMES.error, fps: 8, collar: MOOD_COLLARS.error },
  },
};
