import { BLACKSMITH_FRAMES } from './blacksmithFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/**
 * Animated blacksmith: PixelLab-generated 92x92 bitmap frames per mood — breathing idle, hammers
 * iron on the anvil while working, holds the tongs, waiting when a session needs you, quenches a
 * finished blade on done, the metal cracks on the anvil on error — plus the shared collar badge
 * hue per mood.
 */
export const blacksmithAnimated: AnimatedPetSprite = {
  kind: 'blacksmith',
  name: 'Blacksmith',
  moods: {
    idle: { frames: BLACKSMITH_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: BLACKSMITH_FRAMES.working, fps: 8, collar: MOOD_COLLARS.working },
    needs: { frames: BLACKSMITH_FRAMES.needs, fps: 7, collar: MOOD_COLLARS.needs },
    done: { frames: BLACKSMITH_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: BLACKSMITH_FRAMES.error, fps: 8, collar: MOOD_COLLARS.error },
  },
};
