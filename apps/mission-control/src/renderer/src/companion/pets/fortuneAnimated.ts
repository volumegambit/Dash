import { FORTUNE_GOD_FRAMES } from './fortuneFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/**
 * Animated fortune god: PixelLab-generated 92x92 bitmap frames per mood —
 * strokes his beard while idle, counts gold coins while working, offers a red envelope when a session needs you, tosses coins in the air on done, drops the gold ingot on his foot on error — plus the shared collar badge hue per mood.
 */
export const fortuneGodAnimated: AnimatedPetSprite = {
  kind: 'fortune-god',
  name: 'Fortune God',
  moods: {
    idle: { frames: FORTUNE_GOD_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: FORTUNE_GOD_FRAMES.working, fps: 8, collar: MOOD_COLLARS.working },
    needs: { frames: FORTUNE_GOD_FRAMES.needs, fps: 6, collar: MOOD_COLLARS.needs },
    done: { frames: FORTUNE_GOD_FRAMES.done, fps: 9, collar: MOOD_COLLARS.done },
    error: { frames: FORTUNE_GOD_FRAMES.error, fps: 8, collar: MOOD_COLLARS.error },
  },
};
