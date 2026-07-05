import { STREAMER_FRAMES } from './streamerFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/**
 * Animated streamer: PixelLab-generated 92x92 bitmap frames per mood —
 * breathing idle, mashes the controller while working, points at the subscribe button when a session needs you, throws a victory cheer on done, rage-quits on error — plus the shared collar badge hue per mood.
 */
export const streamerAnimated: AnimatedPetSprite = {
  kind: 'streamer',
  name: 'Streamer',
  moods: {
    idle: { frames: STREAMER_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: STREAMER_FRAMES.working, fps: 11, collar: MOOD_COLLARS.working },
    needs: { frames: STREAMER_FRAMES.needs, fps: 7, collar: MOOD_COLLARS.needs },
    done: { frames: STREAMER_FRAMES.done, fps: 9, collar: MOOD_COLLARS.done },
    error: { frames: STREAMER_FRAMES.error, fps: 9, collar: MOOD_COLLARS.error },
  },
};
