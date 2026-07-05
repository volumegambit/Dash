import { FIRE_CHIEF_FRAMES } from './fireChiefFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/**
 * Animated fire chief: PixelLab-generated 92x92 bitmap frames per mood — breathing idle, directs
 * the crew by radio while working, surveys the scene, waiting when a session needs you, gives
 * the all-clear on done, calls for a second alarm on error — plus the shared collar badge hue
 * per mood.
 */
export const fireChiefAnimated: AnimatedPetSprite = {
  kind: 'fire-chief',
  name: 'Fire Chief',
  moods: {
    idle: { frames: FIRE_CHIEF_FRAMES.idle, fps: 4, collar: MOOD_COLLARS.idle },
    working: { frames: FIRE_CHIEF_FRAMES.working, fps: 8, collar: MOOD_COLLARS.working },
    needs: { frames: FIRE_CHIEF_FRAMES.needs, fps: 7, collar: MOOD_COLLARS.needs },
    done: { frames: FIRE_CHIEF_FRAMES.done, fps: 9, collar: MOOD_COLLARS.done },
    error: { frames: FIRE_CHIEF_FRAMES.error, fps: 8, collar: MOOD_COLLARS.error },
  },
};
