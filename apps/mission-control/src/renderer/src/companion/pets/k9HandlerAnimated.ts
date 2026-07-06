import { K9_HANDLER_FRAMES } from './k9HandlerFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/** K9 Handler: PixelLab 92px frames per mood. */
export const k9HandlerAnimated: AnimatedPetSprite = {
  kind: 'k9-handler',
  name: 'K9 Handler',
  moods: {
    idle: { frames: K9_HANDLER_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: K9_HANDLER_FRAMES.working, fps: 10, collar: MOOD_COLLARS.working },
    needs: { frames: K9_HANDLER_FRAMES.needs, fps: 6, collar: MOOD_COLLARS.needs },
    done: { frames: K9_HANDLER_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: K9_HANDLER_FRAMES.error, fps: 8, collar: MOOD_COLLARS.error },
  },
};
