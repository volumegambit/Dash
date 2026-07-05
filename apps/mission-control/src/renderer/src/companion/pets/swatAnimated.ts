import { SWAT_FRAMES } from './swatFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/**
 * Animated swat: PixelLab-generated 92x92 bitmap frames per mood — breathing idle, breaches with
 * a raised shield while working, stacks up, waiting on the go when a session needs you, signals
 * — area secured on done, takes cover under fire on error — plus the shared collar badge hue per
 * mood.
 */
export const swatAnimated: AnimatedPetSprite = {
  kind: 'swat',
  name: 'SWAT',
  moods: {
    idle: { frames: SWAT_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: SWAT_FRAMES.working, fps: 10, collar: MOOD_COLLARS.working },
    needs: { frames: SWAT_FRAMES.needs, fps: 7, collar: MOOD_COLLARS.needs },
    done: { frames: SWAT_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: SWAT_FRAMES.error, fps: 9, collar: MOOD_COLLARS.error },
  },
};
