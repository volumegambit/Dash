import { expect, test } from 'vitest';
import { DONE_LINGER_MS, bubbleVisibility } from './bubbleVisibility.js';

test('working / needs / error are always visible', () => {
  expect(bubbleVisibility('working', 0, 999_999)).toBe(true);
  expect(bubbleVisibility('needs', 0, 999_999)).toBe(true);
  expect(bubbleVisibility('error', 0, 999_999)).toBe(true);
});

test('idle is never visible', () => {
  expect(bubbleVisibility('idle', 0, 0)).toBe(false);
});

test('done lingers then fades', () => {
  // Just finished: visible.
  expect(bubbleVisibility('done', 1_000, 1_000)).toBe(true);
  // Within the linger window: still visible.
  expect(bubbleVisibility('done', 1_000, 1_000 + DONE_LINGER_MS - 1)).toBe(true);
  // Past the linger window: hidden.
  expect(bubbleVisibility('done', 1_000, 1_000 + DONE_LINGER_MS + 1)).toBe(false);
});

test('done exactly at the linger boundary is hidden', () => {
  expect(bubbleVisibility('done', 1_000, 1_000 + DONE_LINGER_MS)).toBe(false);
});

test('a done timestamp in the future (clock skew) is treated as just-finished', () => {
  expect(bubbleVisibility('done', 5_000, 4_000)).toBe(true);
});
