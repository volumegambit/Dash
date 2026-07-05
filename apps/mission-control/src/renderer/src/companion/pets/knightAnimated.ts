import { KNIGHT_FRAMES } from './knightFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/**
 * Animated knight: PixelLab-generated 92x92 bitmap frames per mood —
 * breathing idle, drags a heavy load while working, bangs sword on shield when a session needs you, raises sword and shield on done, slumps dejectedly on error — plus the shared collar badge hue per mood.
 */
export const knightAnimated: AnimatedPetSprite = {
  kind: 'knight',
  name: 'Knight',
  moods: {
    idle: { frames: KNIGHT_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: KNIGHT_FRAMES.working, fps: 7, collar: MOOD_COLLARS.working },
    needs: { frames: KNIGHT_FRAMES.needs, fps: 8, collar: MOOD_COLLARS.needs },
    done: { frames: KNIGHT_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: KNIGHT_FRAMES.error, fps: 5, collar: MOOD_COLLARS.error },
  },
};
