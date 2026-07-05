import { BOSS_FRAMES } from './bossFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/**
 * Animated boss: PixelLab-generated 92x92 bitmap frames per mood — breathing idle, signs papers
 * at the desk while working, drums fingers, waiting on you when a session needs you, gives a
 * confident thumbs-up on done, crumples a report in frustration on error — plus the shared
 * collar badge hue per mood.
 */
export const bossAnimated: AnimatedPetSprite = {
  kind: 'boss',
  name: 'Boss',
  moods: {
    idle: { frames: BOSS_FRAMES.idle, fps: 4, collar: MOOD_COLLARS.idle },
    working: { frames: BOSS_FRAMES.working, fps: 8, collar: MOOD_COLLARS.working },
    needs: { frames: BOSS_FRAMES.needs, fps: 7, collar: MOOD_COLLARS.needs },
    done: { frames: BOSS_FRAMES.done, fps: 9, collar: MOOD_COLLARS.done },
    error: { frames: BOSS_FRAMES.error, fps: 8, collar: MOOD_COLLARS.error },
  },
};
