import { CHEF_FRAMES } from './chefFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/**
 * Animated chef: PixelLab-generated 92x92 bitmap frames per mood —
 * breathing idle, chops vegetables while working, rings a service bell when a session needs you, presents the finished dish on done, panics over a boiling pot on error — plus the shared collar badge hue per mood.
 */
export const chefAnimated: AnimatedPetSprite = {
  kind: 'chef',
  name: 'Chef',
  moods: {
    idle: { frames: CHEF_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: CHEF_FRAMES.working, fps: 10, collar: MOOD_COLLARS.working },
    needs: { frames: CHEF_FRAMES.needs, fps: 8, collar: MOOD_COLLARS.needs },
    done: { frames: CHEF_FRAMES.done, fps: 7, collar: MOOD_COLLARS.done },
    error: { frames: CHEF_FRAMES.error, fps: 9, collar: MOOD_COLLARS.error },
  },
};
