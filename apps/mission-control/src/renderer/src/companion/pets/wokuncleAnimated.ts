import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';
import { WOK_UNCLE_FRAMES } from './wokuncleFrames.js';

/**
 * Animated wok uncle: PixelLab-generated 92x92 bitmap frames per mood —
 * breathing idle, tosses fried rice in a flaming wok while working, crosses its arms and shakes its head when a session needs you, gives a chef's kiss on done, facepalms in deep disappointment on error — plus the shared collar badge hue per mood.
 */
export const wokUncleAnimated: AnimatedPetSprite = {
  kind: 'wok-uncle',
  name: 'Wok Uncle',
  moods: {
    idle: { frames: WOK_UNCLE_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: WOK_UNCLE_FRAMES.working, fps: 10, collar: MOOD_COLLARS.working },
    needs: { frames: WOK_UNCLE_FRAMES.needs, fps: 6, collar: MOOD_COLLARS.needs },
    done: { frames: WOK_UNCLE_FRAMES.done, fps: 7, collar: MOOD_COLLARS.done },
    error: { frames: WOK_UNCLE_FRAMES.error, fps: 6, collar: MOOD_COLLARS.error },
  },
};
