import { BUBBLE_TEA_MAKER_FRAMES } from './bubbleTeaMakerFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/** Bubble Tea Maker: PixelLab 92px frames per mood. */
export const bubbleTeaMakerAnimated: AnimatedPetSprite = {
  kind: 'bubble-tea-maker',
  name: 'Bubble Tea Maker',
  moods: {
    idle: { frames: BUBBLE_TEA_MAKER_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: BUBBLE_TEA_MAKER_FRAMES.working, fps: 10, collar: MOOD_COLLARS.working },
    needs: { frames: BUBBLE_TEA_MAKER_FRAMES.needs, fps: 6, collar: MOOD_COLLARS.needs },
    done: { frames: BUBBLE_TEA_MAKER_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: BUBBLE_TEA_MAKER_FRAMES.error, fps: 8, collar: MOOD_COLLARS.error },
  },
};
