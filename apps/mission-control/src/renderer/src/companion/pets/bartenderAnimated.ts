import { BARTENDER_FRAMES } from './bartenderFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/**
 * Animated bartender: PixelLab-generated 92x92 bitmap frames per mood — breathing idle, shakes a
 * cocktail with rhythm while working, polishes a glass, waiting when a session needs you, slides
 * the drink down the bar on done, the shaker pops and spills on error — plus the shared collar
 * badge hue per mood.
 */
export const bartenderAnimated: AnimatedPetSprite = {
  kind: 'bartender',
  name: 'Bartender',
  moods: {
    idle: { frames: BARTENDER_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: BARTENDER_FRAMES.working, fps: 10, collar: MOOD_COLLARS.working },
    needs: { frames: BARTENDER_FRAMES.needs, fps: 7, collar: MOOD_COLLARS.needs },
    done: { frames: BARTENDER_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: BARTENDER_FRAMES.error, fps: 8, collar: MOOD_COLLARS.error },
  },
};
