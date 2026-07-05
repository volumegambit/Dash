import { SOMMELIER_FRAMES } from './sommelierFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/**
 * Animated sommelier: PixelLab-generated 92x92 bitmap frames per mood — breathing idle, swirls
 * and sniffs the glass while working, presents the bottle, waiting when a session needs you,
 * nods — a fine vintage on done, the cork crumbles on error — plus the shared collar badge hue
 * per mood.
 */
export const sommelierAnimated: AnimatedPetSprite = {
  kind: 'sommelier',
  name: 'Sommelier',
  moods: {
    idle: { frames: SOMMELIER_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: SOMMELIER_FRAMES.working, fps: 7, collar: MOOD_COLLARS.working },
    needs: { frames: SOMMELIER_FRAMES.needs, fps: 6, collar: MOOD_COLLARS.needs },
    done: { frames: SOMMELIER_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: SOMMELIER_FRAMES.error, fps: 7, collar: MOOD_COLLARS.error },
  },
};
