import { PIG_FRAMES } from './pigFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/**
 * Animated pig: PixelLab-generated 92x92 bitmap frames per mood — resting
 * idle, rooting busily in the dirt while working, sitting up when a session
 * needs you, jumping when done, stomping angrily on error — plus the shared
 * collar badge hue per mood.
 */
export const pigAnimated: AnimatedPetSprite = {
  kind: 'pig',
  name: 'Pig',
  moods: {
    idle: { frames: PIG_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: PIG_FRAMES.working, fps: 9, collar: MOOD_COLLARS.working },
    needs: { frames: PIG_FRAMES.needs, fps: 5, collar: MOOD_COLLARS.needs },
    done: { frames: PIG_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: PIG_FRAMES.error, fps: 8, collar: MOOD_COLLARS.error },
  },
};
