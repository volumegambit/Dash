import { BEEKEEPER_FRAMES } from './beekeeperFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/**
 * Animated beekeeper: PixelLab-generated 92x92 bitmap frames per mood — breathing idle, tends
 * the hive with a smoker while working, holds a frame, waiting when a session needs you, lifts a
 * golden honeycomb on done, the bees swarm out on error — plus the shared collar badge hue per
 * mood.
 */
export const beekeeperAnimated: AnimatedPetSprite = {
  kind: 'beekeeper',
  name: 'Beekeeper',
  moods: {
    idle: { frames: BEEKEEPER_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: BEEKEEPER_FRAMES.working, fps: 8, collar: MOOD_COLLARS.working },
    needs: { frames: BEEKEEPER_FRAMES.needs, fps: 7, collar: MOOD_COLLARS.needs },
    done: { frames: BEEKEEPER_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: BEEKEEPER_FRAMES.error, fps: 8, collar: MOOD_COLLARS.error },
  },
};
