import { BARISTA_FRAMES } from './baristaFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/**
 * Animated barista: PixelLab-generated 92x92 bitmap frames per mood — breathing idle, pulls a
 * shot and steams milk while working, wipes the counter, waiting when a session needs you, pours
 * latte art with a flourish on done, the milk scalds and foams over on error — plus the shared
 * collar badge hue per mood.
 */
export const baristaAnimated: AnimatedPetSprite = {
  kind: 'barista',
  name: 'Barista',
  moods: {
    idle: { frames: BARISTA_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: BARISTA_FRAMES.working, fps: 9, collar: MOOD_COLLARS.working },
    needs: { frames: BARISTA_FRAMES.needs, fps: 7, collar: MOOD_COLLARS.needs },
    done: { frames: BARISTA_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: BARISTA_FRAMES.error, fps: 9, collar: MOOD_COLLARS.error },
  },
};
