import { IT_SUPPORT_FRAMES } from './itSupportFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/**
 * Animated it support: PixelLab-generated 92x92 bitmap frames per mood — breathing idle, types
 * furiously to fix a ticket while working, holds a cable, waiting on you when a session needs
 * you, reboots it — problem solved on done, the screen flashes an error on error — plus the
 * shared collar badge hue per mood.
 */
export const itSupportAnimated: AnimatedPetSprite = {
  kind: 'it-support',
  name: 'IT Support',
  moods: {
    idle: { frames: IT_SUPPORT_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: IT_SUPPORT_FRAMES.working, fps: 9, collar: MOOD_COLLARS.working },
    needs: { frames: IT_SUPPORT_FRAMES.needs, fps: 7, collar: MOOD_COLLARS.needs },
    done: { frames: IT_SUPPORT_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: IT_SUPPORT_FRAMES.error, fps: 9, collar: MOOD_COLLARS.error },
  },
};
