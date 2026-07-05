import { QUOKKA_FRAMES } from './quokkaFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/**
 * Animated quokka: PixelLab-generated 92x92 bitmap frames per mood —
 * grinning idle, hops busily while working, sits down waiting when a session needs you, leans in for a selfie on done, briefly stops smiling on error — plus the shared collar badge hue per mood.
 */
export const quokkaAnimated: AnimatedPetSprite = {
  kind: 'quokka',
  name: 'Quokka',
  moods: {
    idle: { frames: QUOKKA_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: QUOKKA_FRAMES.working, fps: 9, collar: MOOD_COLLARS.working },
    needs: { frames: QUOKKA_FRAMES.needs, fps: 5, collar: MOOD_COLLARS.needs },
    done: { frames: QUOKKA_FRAMES.done, fps: 7, collar: MOOD_COLLARS.done },
    error: { frames: QUOKKA_FRAMES.error, fps: 8, collar: MOOD_COLLARS.error },
  },
};
