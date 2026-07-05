import { RED_PANDA_FRAMES } from './redPandaFrames.js';
import type { AnimatedPetSprite } from './types.js';

/**
 * Animated red panda: PixelLab-generated 92x92 bitmap frames per mood. Mood
 * is conveyed by the animation itself (asleep-ish idle, running while
 * working, sitting when a session needs you, jumping when done, bristling on
 * error) plus a collar badge dot using the same per-mood hues as the grid
 * pets' collar tags.
 */
export const redPandaAnimated: AnimatedPetSprite = {
  kind: 'red-panda',
  name: 'Red panda',
  moods: {
    idle: { frames: RED_PANDA_FRAMES.idle, fps: 5, collar: '#9aa0a6' },
    working: { frames: RED_PANDA_FRAMES.working, fps: 10, collar: '#3da5d9' },
    needs: { frames: RED_PANDA_FRAMES.needs, fps: 5, collar: '#f5c518' },
    done: { frames: RED_PANDA_FRAMES.done, fps: 8, collar: '#34c759' },
    error: { frames: RED_PANDA_FRAMES.error, fps: 7, collar: '#f87171' },
  },
};
