import { MERLION_FRAMES } from './merlionFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/**
 * Animated merlion: PixelLab-generated 92x92 bitmap frames per mood —
 * idle, spouts an arcing water jet while working, looks up expectantly when a session needs you, erupts a celebratory fountain on done, snarls and splashes on error — plus the shared collar badge hue per mood.
 */
export const merlionAnimated: AnimatedPetSprite = {
  kind: 'merlion',
  name: 'Merlion',
  moods: {
    idle: { frames: MERLION_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: MERLION_FRAMES.working, fps: 8, collar: MOOD_COLLARS.working },
    needs: { frames: MERLION_FRAMES.needs, fps: 6, collar: MOOD_COLLARS.needs },
    done: { frames: MERLION_FRAMES.done, fps: 9, collar: MOOD_COLLARS.done },
    error: { frames: MERLION_FRAMES.error, fps: 8, collar: MOOD_COLLARS.error },
  },
};
