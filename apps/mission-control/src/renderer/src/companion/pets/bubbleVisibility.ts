import type { Mood } from './types.js';

/**
 * How long a `done` bubble lingers after the session finishes before it fades,
 * so it reads as a transient notification rather than permanent chrome.
 */
export const DONE_LINGER_MS = 4_000;

/**
 * Pure visibility rule for a companion speech bubble. Kept free of the wall
 * clock so it is unit-testable; the component passes `Date.now()` as `nowMs`.
 *
 * - `working` / `needs` / `error` → always visible (active attention).
 * - `done` → visible for {@link DONE_LINGER_MS} after `sinceMs`, then hidden.
 * - `idle` → never visible.
 */
export function bubbleVisibility(mood: Mood, sinceMs: number, nowMs: number): boolean {
  switch (mood) {
    case 'working':
    case 'needs':
    case 'error':
      return true;
    case 'done':
      return nowMs - sinceMs < DONE_LINGER_MS;
    default:
      return false;
  }
}
