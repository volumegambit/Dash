import { ASTRONAUT_FRAMES } from './astronautFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/**
 * Animated astronaut: PixelLab-generated 92x92 bitmap frames per mood —
 * floats in zero gravity while idle, tightens bolts with a wrench while working, waves both arms when a session needs you, does a two-footed jump on done, startles at a helmet alarm on error — plus the shared collar badge hue per mood.
 */
export const astronautAnimated: AnimatedPetSprite = {
  kind: 'astronaut',
  name: 'Astronaut',
  moods: {
    idle: { frames: ASTRONAUT_FRAMES.idle, fps: 4, collar: MOOD_COLLARS.idle },
    working: { frames: ASTRONAUT_FRAMES.working, fps: 8, collar: MOOD_COLLARS.working },
    needs: { frames: ASTRONAUT_FRAMES.needs, fps: 8, collar: MOOD_COLLARS.needs },
    done: { frames: ASTRONAUT_FRAMES.done, fps: 9, collar: MOOD_COLLARS.done },
    error: { frames: ASTRONAUT_FRAMES.error, fps: 8, collar: MOOD_COLLARS.error },
  },
};
