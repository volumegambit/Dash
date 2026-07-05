import { BOLLYWOOD_FRAMES } from './bollywoodFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/**
 * Animated bollywood star: PixelLab-generated 92x92 bitmap frames per mood —
 * breathing idle, spins a dance move while working, beckons dramatically when a session needs you, strikes a signature pose on done, swoons in dramatic heartbreak on error — plus the shared collar badge hue per mood.
 */
export const bollywoodStarAnimated: AnimatedPetSprite = {
  kind: 'bollywood-star',
  name: 'Bollywood Star',
  moods: {
    idle: { frames: BOLLYWOOD_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: BOLLYWOOD_FRAMES.working, fps: 10, collar: MOOD_COLLARS.working },
    needs: { frames: BOLLYWOOD_FRAMES.needs, fps: 8, collar: MOOD_COLLARS.needs },
    done: { frames: BOLLYWOOD_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: BOLLYWOOD_FRAMES.error, fps: 6, collar: MOOD_COLLARS.error },
  },
};
