import { FISHERMAN_FRAMES } from './fishermanFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/**
 * Animated fisherman: PixelLab-generated 92x92 bitmap frames per mood — breathing idle, casts
 * and reels the line while working, holds the rod steady, waiting when a session needs you,
 * lands a fish, holds it high on done, the line snaps on error — plus the shared collar badge
 * hue per mood.
 */
export const fishermanAnimated: AnimatedPetSprite = {
  kind: 'fisherman',
  name: 'Fisherman',
  moods: {
    idle: { frames: FISHERMAN_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: FISHERMAN_FRAMES.working, fps: 8, collar: MOOD_COLLARS.working },
    needs: { frames: FISHERMAN_FRAMES.needs, fps: 7, collar: MOOD_COLLARS.needs },
    done: { frames: FISHERMAN_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: FISHERMAN_FRAMES.error, fps: 7, collar: MOOD_COLLARS.error },
  },
};
