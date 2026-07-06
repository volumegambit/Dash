import { useEffect, useRef, useState } from 'react';
import { bubbleVisibility } from './bubbleVisibility.js';
import type { Mood } from './types.js';

/**
 * Whether a speech bubble for `mood` should currently show. Stamps when the
 * mood last changed so a `done` bubble lingers then fades, and ticks a clock
 * while a fade is pending — delegating the decision to the pure
 * {@link bubbleVisibility}. Wall-clock lives here, not in the presentational
 * bubble, so the rule stays unit-testable.
 */
export function useBubbleVisible(mood: Mood): boolean {
  const stamp = useRef<{ mood: Mood; since: number }>({ mood, since: Date.now() });
  if (stamp.current.mood !== mood) stamp.current = { mood, since: Date.now() };

  // Re-evaluate on a timer only while the bubble is on a fade countdown.
  const [, setTick] = useState(0);
  const fading = mood === 'done';
  useEffect(() => {
    if (!fading) return undefined;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [fading]);

  return bubbleVisibility(mood, stamp.current.since, Date.now());
}
