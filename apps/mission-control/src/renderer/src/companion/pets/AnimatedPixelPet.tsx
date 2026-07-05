import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import type { AnimatedPetSprite, Mood } from './types.js';

/** Playback speed when a mood doesn't specify its own. */
export const DEFAULT_FPS = 8;

/**
 * Static-frame fallback for users who opt out of motion at the OS level.
 * jsdom has no `matchMedia`, so absence means "no preference".
 */
function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * Renders a frame-based pet: loops the current mood's frames on a timer and
 * shows the mood's collar hue as a small badge dot. Inline styles only — this
 * renders in both the main window and the bare companion widget window, which
 * does not load the app stylesheet.
 */
export function AnimatedPixelPet({
  sprite,
  mood,
  size = 128,
}: {
  sprite: AnimatedPetSprite;
  mood: Mood;
  size?: number;
}): JSX.Element {
  const { frames, fps = DEFAULT_FPS, collar } = sprite.moods[mood];
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    setFrame(0);
    if (frames.length <= 1 || prefersReducedMotion()) return undefined;
    const id = setInterval(() => setFrame((f) => (f + 1) % frames.length), 1000 / fps);
    return () => clearInterval(id);
  }, [frames, fps]);

  const dot = Math.max(6, Math.round(size * 0.09));
  return (
    <div
      role="img"
      aria-label={sprite.name}
      style={{ position: 'relative', width: size, height: size }}
    >
      <img
        src={frames[frame % frames.length]}
        alt=""
        draggable={false}
        style={{ width: '100%', height: '100%', imageRendering: 'pixelated' }}
      />
      <span
        data-testid="collar-dot"
        style={{
          position: 'absolute',
          right: Math.round(size * 0.12),
          bottom: Math.round(size * 0.1),
          width: dot,
          height: dot,
          borderRadius: '50%',
          background: collar,
          boxShadow: '0 0 0 2px rgba(0, 0, 0, 0.35)',
        }}
      />
    </div>
  );
}
