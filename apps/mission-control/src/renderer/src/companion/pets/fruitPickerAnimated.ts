import { FRUIT_PICKER_FRAMES } from './fruitPickerFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/**
 * Animated fruit picker: PixelLab-generated 92x92 bitmap frames per mood — breathing idle,
 * plucks fruit into a basket while working, holds the basket up, waiting when a session needs
 * you, hoists a full basket on done, the basket spills on error — plus the shared collar badge
 * hue per mood.
 */
export const fruitPickerAnimated: AnimatedPetSprite = {
  kind: 'fruit-picker',
  name: 'Fruit Picker',
  moods: {
    idle: { frames: FRUIT_PICKER_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: FRUIT_PICKER_FRAMES.working, fps: 9, collar: MOOD_COLLARS.working },
    needs: { frames: FRUIT_PICKER_FRAMES.needs, fps: 7, collar: MOOD_COLLARS.needs },
    done: { frames: FRUIT_PICKER_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: FRUIT_PICKER_FRAMES.error, fps: 7, collar: MOOD_COLLARS.error },
  },
};
