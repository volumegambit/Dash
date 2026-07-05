import { K9_HANDLER_FRAMES } from './k9HandlerFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/**
 * Animated k9 handler: PixelLab-generated 92x92 bitmap frames per mood — breathing idle, works a
 * search with the dog while working, holds the leash, waiting when a session needs you, rewards
 * a good find on done, the dog bolts off-lead on error — plus the shared collar badge hue per
 * mood.
 */
export const k9HandlerAnimated: AnimatedPetSprite = {
  kind: 'k9-handler',
  name: 'K9 Handler',
  moods: {
    idle: { frames: K9_HANDLER_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: K9_HANDLER_FRAMES.working, fps: 9, collar: MOOD_COLLARS.working },
    needs: { frames: K9_HANDLER_FRAMES.needs, fps: 7, collar: MOOD_COLLARS.needs },
    done: { frames: K9_HANDLER_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: K9_HANDLER_FRAMES.error, fps: 8, collar: MOOD_COLLARS.error },
  },
};
