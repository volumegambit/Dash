import { RADIO_OPERATOR_FRAMES } from './radioOperatorFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/**
 * Animated radio operator: PixelLab-generated 92x92 bitmap frames per mood — breathing idle,
 * works the field radio dials while working, holds the handset, waiting when a session needs
 * you, confirms — message received on done, the signal cuts to static on error — plus the shared
 * collar badge hue per mood.
 */
export const radioOperatorAnimated: AnimatedPetSprite = {
  kind: 'radio-operator',
  name: 'Radio Operator',
  moods: {
    idle: { frames: RADIO_OPERATOR_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: RADIO_OPERATOR_FRAMES.working, fps: 9, collar: MOOD_COLLARS.working },
    needs: { frames: RADIO_OPERATOR_FRAMES.needs, fps: 8, collar: MOOD_COLLARS.needs },
    done: { frames: RADIO_OPERATOR_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: RADIO_OPERATOR_FRAMES.error, fps: 9, collar: MOOD_COLLARS.error },
  },
};
