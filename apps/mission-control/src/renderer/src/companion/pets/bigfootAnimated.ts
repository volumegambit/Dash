import { BIGFOOT_FRAMES } from './bigfootFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/**
 * Animated bigfoot: PixelLab-generated 92x92 bitmap frames per mood —
 * breathing idle, tiptoes sneakily while working, waves shyly then hides when a session needs you, stomp-dances on done, startles and hides its face on error — plus the shared collar badge hue per mood.
 */
export const bigfootAnimated: AnimatedPetSprite = {
  kind: 'bigfoot',
  name: 'Bigfoot',
  moods: {
    idle: { frames: BIGFOOT_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: BIGFOOT_FRAMES.working, fps: 7, collar: MOOD_COLLARS.working },
    needs: { frames: BIGFOOT_FRAMES.needs, fps: 7, collar: MOOD_COLLARS.needs },
    done: { frames: BIGFOOT_FRAMES.done, fps: 9, collar: MOOD_COLLARS.done },
    error: { frames: BIGFOOT_FRAMES.error, fps: 8, collar: MOOD_COLLARS.error },
  },
};
