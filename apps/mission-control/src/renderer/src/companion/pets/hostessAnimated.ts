import { HOSTESS_FRAMES } from './hostessFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/**
 * Animated hostess: PixelLab-generated 92x92 bitmap frames per mood — breathing idle, leads
 * guests with menus in hand while working, gestures toward an open table when a session needs
 * you, seats the party with a smile on done, the reservation is double-booked on error — plus
 * the shared collar badge hue per mood.
 */
export const hostessAnimated: AnimatedPetSprite = {
  kind: 'hostess',
  name: 'Hostess',
  moods: {
    idle: { frames: HOSTESS_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: HOSTESS_FRAMES.working, fps: 8, collar: MOOD_COLLARS.working },
    needs: { frames: HOSTESS_FRAMES.needs, fps: 8, collar: MOOD_COLLARS.needs },
    done: { frames: HOSTESS_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: HOSTESS_FRAMES.error, fps: 7, collar: MOOD_COLLARS.error },
  },
};
