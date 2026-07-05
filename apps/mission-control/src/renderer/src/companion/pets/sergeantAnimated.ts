import { SERGEANT_FRAMES } from './sergeantFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/**
 * Animated sergeant: PixelLab-generated 92x92 bitmap frames per mood — breathing idle, barks
 * orders on the drill while working, stands at parade rest, waiting when a session needs you,
 * snaps a crisp salute on done, fumbles the formation on error — plus the shared collar badge
 * hue per mood.
 */
export const sergeantAnimated: AnimatedPetSprite = {
  kind: 'sergeant',
  name: 'Sergeant',
  moods: {
    idle: { frames: SERGEANT_FRAMES.idle, fps: 4, collar: MOOD_COLLARS.idle },
    working: { frames: SERGEANT_FRAMES.working, fps: 9, collar: MOOD_COLLARS.working },
    needs: { frames: SERGEANT_FRAMES.needs, fps: 7, collar: MOOD_COLLARS.needs },
    done: { frames: SERGEANT_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: SERGEANT_FRAMES.error, fps: 8, collar: MOOD_COLLARS.error },
  },
};
