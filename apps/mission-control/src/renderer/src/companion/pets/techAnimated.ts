import { TECH_REVIEWER_FRAMES } from './techFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/**
 * Animated tech reviewer: PixelLab-generated 92x92 bitmap frames per mood —
 * breathing idle, unboxes a gadget while working, holds its phone up to you when a session needs you, gives a double thumbs up on done, jumps back from the smoking gadget on error — plus the shared collar badge hue per mood.
 */
export const techReviewerAnimated: AnimatedPetSprite = {
  kind: 'tech-reviewer',
  name: 'Tech Reviewer',
  moods: {
    idle: { frames: TECH_REVIEWER_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: TECH_REVIEWER_FRAMES.working, fps: 7, collar: MOOD_COLLARS.working },
    needs: { frames: TECH_REVIEWER_FRAMES.needs, fps: 7, collar: MOOD_COLLARS.needs },
    done: { frames: TECH_REVIEWER_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: TECH_REVIEWER_FRAMES.error, fps: 9, collar: MOOD_COLLARS.error },
  },
};
