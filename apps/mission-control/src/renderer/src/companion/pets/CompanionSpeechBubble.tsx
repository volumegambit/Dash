import type { CSSProperties, JSX } from 'react';
import type { Mood } from './types.js';
import { MOOD_COLLARS } from './types.js';

/**
 * Whether the OS asked us to minimize motion. jsdom has no `matchMedia`, so its
 * absence means "no preference" (animate) — matching {@link AnimatedPixelPet}.
 */
function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * A small rounded speech bubble shown above a companion pet, surfacing what its
 * agent is doing (`text`). Mood-tinted via {@link MOOD_COLLARS}, single-line
 * with an ellipsis, announced politely to screen readers. Presentational only —
 * visibility is decided by the caller (see `bubbleVisibility`). Inline styles
 * only: this renders in the bare widget window, which has no app stylesheet.
 *
 * Renders nothing when hidden or when the text is empty/whitespace.
 */
export function CompanionSpeechBubble({
  text,
  mood,
  visible,
}: {
  text: string;
  mood: Mood;
  visible: boolean;
}): JSX.Element | null {
  const trimmed = text.trim();
  if (!visible || trimmed.length === 0) return null;

  const hue = MOOD_COLLARS[mood];
  const style: CSSProperties = {
    position: 'absolute',
    bottom: '100%',
    left: '50%',
    transform: 'translateX(-50%)',
    marginBottom: 6,
    maxWidth: 132,
    padding: '4px 8px',
    borderRadius: 10,
    border: `1.5px solid ${hue}`,
    background: 'rgba(20, 22, 28, 0.92)',
    color: '#f3f4f6',
    fontSize: 11,
    lineHeight: '14px',
    fontFamily: 'system-ui, -apple-system, sans-serif',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    boxShadow: `0 2px 6px rgba(0, 0, 0, 0.35), 0 0 0 1px ${hue}22`,
    pointerEvents: 'none',
    animation: prefersReducedMotion() ? undefined : 'companion-bubble-in 140ms ease-out',
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: a styled div is the bubble; <output> is form-associated and carries unwanted semantics
    <div role="status" aria-live="polite" style={style}>
      {trimmed}
      {/* Downward tail: a small square rotated 45°, tinted to match the border. */}
      <span
        aria-hidden="true"
        style={{
          position: 'absolute',
          top: '100%',
          left: '50%',
          width: 8,
          height: 8,
          marginTop: -5,
          transform: 'translateX(-50%) rotate(45deg)',
          background: 'rgba(20, 22, 28, 0.92)',
          borderRight: `1.5px solid ${hue}`,
          borderBottom: `1.5px solid ${hue}`,
        }}
      />
    </div>
  );
}
