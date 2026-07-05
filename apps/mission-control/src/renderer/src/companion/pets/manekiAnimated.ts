import { MANEKI_NEKO_FRAMES } from './manekiFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/**
 * Animated maneki-neko: PixelLab-generated 92x92 bitmap frames per mood —
 * idle, beckons rhythmically while working, holds up a gold coin when a session needs you, jumps on done, bristles on error — plus the shared collar badge hue per mood.
 */
export const manekiNekoAnimated: AnimatedPetSprite = {
  kind: 'maneki-neko',
  name: 'Maneki-neko',
  moods: {
    idle: { frames: MANEKI_NEKO_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: MANEKI_NEKO_FRAMES.working, fps: 7, collar: MOOD_COLLARS.working },
    needs: { frames: MANEKI_NEKO_FRAMES.needs, fps: 7, collar: MOOD_COLLARS.needs },
    done: { frames: MANEKI_NEKO_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: MANEKI_NEKO_FRAMES.error, fps: 8, collar: MOOD_COLLARS.error },
  },
};
