import { TRAVEL_VLOGGER_FRAMES } from './travelFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/**
 * Animated travel vlogger: PixelLab-generated 92x92 bitmap frames per mood —
 * breathing idle, films with a selfie stick while working, waves a map when a session needs you, strikes a mid-air jump photo pose on done, fumbles the camera on error — plus the shared collar badge hue per mood.
 */
export const travelVloggerAnimated: AnimatedPetSprite = {
  kind: 'travel-vlogger',
  name: 'Travel Vlogger',
  moods: {
    idle: { frames: TRAVEL_VLOGGER_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: TRAVEL_VLOGGER_FRAMES.working, fps: 8, collar: MOOD_COLLARS.working },
    needs: { frames: TRAVEL_VLOGGER_FRAMES.needs, fps: 7, collar: MOOD_COLLARS.needs },
    done: { frames: TRAVEL_VLOGGER_FRAMES.done, fps: 9, collar: MOOD_COLLARS.done },
    error: { frames: TRAVEL_VLOGGER_FRAMES.error, fps: 10, collar: MOOD_COLLARS.error },
  },
};
