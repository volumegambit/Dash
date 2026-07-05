import { ROOKIE_FIREFIGHTER_FRAMES } from './rookieFirefighterFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/**
 * Animated rookie firefighter: PixelLab-generated 92x92 bitmap frames per mood — breathing idle,
 * hauls a heavy hose, eager while working, catches breath, waiting when a session needs you,
 * pumps a fist — first save on done, fumbles the coupling on error — plus the shared collar
 * badge hue per mood.
 */
export const rookieFirefighterAnimated: AnimatedPetSprite = {
  kind: 'rookie-firefighter',
  name: 'Rookie Firefighter',
  moods: {
    idle: { frames: ROOKIE_FIREFIGHTER_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: ROOKIE_FIREFIGHTER_FRAMES.working, fps: 10, collar: MOOD_COLLARS.working },
    needs: { frames: ROOKIE_FIREFIGHTER_FRAMES.needs, fps: 8, collar: MOOD_COLLARS.needs },
    done: { frames: ROOKIE_FIREFIGHTER_FRAMES.done, fps: 9, collar: MOOD_COLLARS.done },
    error: { frames: ROOKIE_FIREFIGHTER_FRAMES.error, fps: 8, collar: MOOD_COLLARS.error },
  },
};
