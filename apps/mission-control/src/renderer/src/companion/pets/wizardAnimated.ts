import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';
import { WIZARD_FRAMES } from './wizardFrames.js';

/**
 * Animated wizard: PixelLab-generated 92x92 bitmap frames per mood —
 * breathing idle, casts a fireball while working, waves a sparkling hand when a session needs you, twirls the staff on done, spell backfires on error — plus the shared collar badge hue per mood.
 */
export const wizardAnimated: AnimatedPetSprite = {
  kind: 'wizard',
  name: 'Wizard',
  moods: {
    idle: { frames: WIZARD_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: WIZARD_FRAMES.working, fps: 8, collar: MOOD_COLLARS.working },
    needs: { frames: WIZARD_FRAMES.needs, fps: 7, collar: MOOD_COLLARS.needs },
    done: { frames: WIZARD_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: WIZARD_FRAMES.error, fps: 7, collar: MOOD_COLLARS.error },
  },
};
