import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';
import { WAITER_FRAMES } from './waiterFrames.js';

/**
 * Animated waiter: PixelLab-generated 92x92 bitmap frames per mood — breathing idle, balances a
 * laden tray while working, stands ready with a notepad when a session needs you, sets the plate
 * down neatly on done, the tray tips over on error — plus the shared collar badge hue per mood.
 */
export const waiterAnimated: AnimatedPetSprite = {
  kind: 'waiter',
  name: 'Waiter',
  moods: {
    idle: { frames: WAITER_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: WAITER_FRAMES.working, fps: 9, collar: MOOD_COLLARS.working },
    needs: { frames: WAITER_FRAMES.needs, fps: 7, collar: MOOD_COLLARS.needs },
    done: { frames: WAITER_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: WAITER_FRAMES.error, fps: 8, collar: MOOD_COLLARS.error },
  },
};
