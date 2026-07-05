import { BEAUTY_GURU_FRAMES } from './beautyFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/**
 * Animated beauty guru: PixelLab-generated 92x92 bitmap frames per mood —
 * breathing idle, does its makeup while working, beckons with a palette when a session needs you, hair-flips with sparkles on done, gasps at the smudge on error — plus the shared collar badge hue per mood.
 */
export const beautyGuruAnimated: AnimatedPetSprite = {
  kind: 'beauty-guru',
  name: 'Beauty Guru',
  moods: {
    idle: { frames: BEAUTY_GURU_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: BEAUTY_GURU_FRAMES.working, fps: 8, collar: MOOD_COLLARS.working },
    needs: { frames: BEAUTY_GURU_FRAMES.needs, fps: 7, collar: MOOD_COLLARS.needs },
    done: { frames: BEAUTY_GURU_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: BEAUTY_GURU_FRAMES.error, fps: 8, collar: MOOD_COLLARS.error },
  },
};
