import { SOUS_CHEF_FRAMES } from './sousChefFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/**
 * Animated sous chef: PixelLab-generated 92x92 bitmap frames per mood — breathing idle, dices
 * vegetables at a brisk chop while working, taps a spoon and waits for you when a session needs
 * you, plates a dish with a flourish on done, waves off a puff of burnt smoke on error — plus
 * the shared collar badge hue per mood.
 */
export const sousChefAnimated: AnimatedPetSprite = {
  kind: 'sous-chef',
  name: 'Sous Chef',
  moods: {
    idle: { frames: SOUS_CHEF_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: SOUS_CHEF_FRAMES.working, fps: 10, collar: MOOD_COLLARS.working },
    needs: { frames: SOUS_CHEF_FRAMES.needs, fps: 8, collar: MOOD_COLLARS.needs },
    done: { frames: SOUS_CHEF_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: SOUS_CHEF_FRAMES.error, fps: 9, collar: MOOD_COLLARS.error },
  },
};
