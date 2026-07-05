import { ROBOT_FRAMES } from './robotFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/**
 * Animated robot: PixelLab-generated 92x92 bitmap frames per mood —
 * breathing idle, types on a holographic keyboard while working, waves with a flashing antenna when a session needs you, backflips on done, short-circuits on error — plus the shared collar badge hue per mood.
 */
export const robotAnimated: AnimatedPetSprite = {
  kind: 'robot',
  name: 'Robot',
  moods: {
    idle: { frames: ROBOT_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: ROBOT_FRAMES.working, fps: 10, collar: MOOD_COLLARS.working },
    needs: { frames: ROBOT_FRAMES.needs, fps: 8, collar: MOOD_COLLARS.needs },
    done: { frames: ROBOT_FRAMES.done, fps: 10, collar: MOOD_COLLARS.done },
    error: { frames: ROBOT_FRAMES.error, fps: 9, collar: MOOD_COLLARS.error },
  },
};
