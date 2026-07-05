import { RECEPTIONIST_FRAMES } from './receptionistFrames.js';
import type { AnimatedPetSprite } from './types.js';
import { MOOD_COLLARS } from './types.js';

/**
 * Animated receptionist: PixelLab-generated 92x92 bitmap frames per mood — breathing idle,
 * answers a ringing phone while working, waves you over to the desk when a session needs you,
 * hands off a message, all set on done, the phone line drops on error — plus the shared collar
 * badge hue per mood.
 */
export const receptionistAnimated: AnimatedPetSprite = {
  kind: 'receptionist',
  name: 'Receptionist',
  moods: {
    idle: { frames: RECEPTIONIST_FRAMES.idle, fps: 5, collar: MOOD_COLLARS.idle },
    working: { frames: RECEPTIONIST_FRAMES.working, fps: 8, collar: MOOD_COLLARS.working },
    needs: { frames: RECEPTIONIST_FRAMES.needs, fps: 8, collar: MOOD_COLLARS.needs },
    done: { frames: RECEPTIONIST_FRAMES.done, fps: 8, collar: MOOD_COLLARS.done },
    error: { frames: RECEPTIONIST_FRAMES.error, fps: 7, collar: MOOD_COLLARS.error },
  },
};
