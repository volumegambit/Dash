import { FRUIT_PICKER_FRAMES } from './fruitPickerFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/** Fruit Picker: PixelLab 92px frames per mood. */
export const fruitPickerAnimated: AnimatedPetSprite = {
  kind: 'fruit-picker',
  name: 'Fruit Picker',
  moods: {
    idle: { frames: FRUIT_PICKER_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: FRUIT_PICKER_FRAMES.working, fps: 10, collar: MOOD_COLLARS.working },
    needs: { frames: FRUIT_PICKER_FRAMES.needs, fps: 6, collar: MOOD_COLLARS.needs },
    done: { frames: FRUIT_PICKER_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: FRUIT_PICKER_FRAMES.error, fps: 8, collar: MOOD_COLLARS.error },
  },
};
