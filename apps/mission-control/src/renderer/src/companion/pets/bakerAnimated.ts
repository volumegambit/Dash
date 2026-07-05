import { BAKER_FRAMES } from './bakerFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/**
 * Animated baker: PixelLab-generated 92x92 bitmap frames per mood — breathing idle, kneads dough
 * on the board while working, dusts hands with flour, waiting when a session needs you, pulls a
 * fresh loaf from the oven on done, the bread comes out burnt on error — plus the shared collar
 * badge hue per mood.
 */
export const bakerAnimated: AnimatedPetSprite = {
  kind: 'baker',
  name: 'Baker',
  moods: {
    idle: { frames: BAKER_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: BAKER_FRAMES.working, fps: 9, collar: MOOD_COLLARS.working },
    needs: { frames: BAKER_FRAMES.needs, fps: 7, collar: MOOD_COLLARS.needs },
    done: { frames: BAKER_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: BAKER_FRAMES.error, fps: 8, collar: MOOD_COLLARS.error },
  },
};
