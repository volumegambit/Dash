import { BEAR_FRAMES } from './bearFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/**
 * Animated bear: PixelLab-generated 92x92 bitmap frames per mood —
 * rests while idle, catches fish while working, sits up when a session needs you, jumps on done, bristles on error — plus the shared collar badge hue per mood.
 */
export const bearAnimated: AnimatedPetSprite = {
  kind: 'bear',
  name: 'Bear',
  moods: {
    idle: { frames: BEAR_FRAMES.idle, fps: 4, collar: MOOD_COLLARS.idle },
    working: { frames: BEAR_FRAMES.working, fps: 8, collar: MOOD_COLLARS.working },
    needs: { frames: BEAR_FRAMES.needs, fps: 5, collar: MOOD_COLLARS.needs },
    done: { frames: BEAR_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: BEAR_FRAMES.error, fps: 8, collar: MOOD_COLLARS.error },
  },
};
