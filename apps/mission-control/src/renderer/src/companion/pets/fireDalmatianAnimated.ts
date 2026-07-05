import { FIRE_DALMATIAN_FRAMES } from './fireDalmatianFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/**
 * Animated fire dalmatian: PixelLab-generated 92x92 bitmap frames per mood — quadruped idle,
 * trots alongside the engine while working, sits and waits by the truck when a session needs
 * you, barks happily, tail wagging on done, cowers at the alarm bell on error — plus the shared
 * collar badge hue per mood.
 */
export const fireDalmatianAnimated: AnimatedPetSprite = {
  kind: 'fire-dalmatian',
  name: 'Fire Dalmatian',
  moods: {
    idle: { frames: FIRE_DALMATIAN_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: FIRE_DALMATIAN_FRAMES.working, fps: 9, collar: MOOD_COLLARS.working },
    needs: { frames: FIRE_DALMATIAN_FRAMES.needs, fps: 6, collar: MOOD_COLLARS.needs },
    done: { frames: FIRE_DALMATIAN_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: FIRE_DALMATIAN_FRAMES.error, fps: 7, collar: MOOD_COLLARS.error },
  },
};
