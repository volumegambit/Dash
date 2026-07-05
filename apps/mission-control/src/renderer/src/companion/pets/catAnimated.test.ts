import { expect, test } from 'vitest';
import { catAnimated } from './catAnimated.js';
import type { Mood } from './types.js';
import { MOOD_COLLARS } from './types.js';

const MOODS: Mood[] = ['idle', 'working', 'needs', 'done', 'error'];

test('defines all five moods with PNG data-URI frames', () => {
  for (const mood of MOODS) {
    const { frames } = catAnimated.moods[mood];
    expect(frames.length, mood).toBeGreaterThan(1);
    for (const frame of frames) {
      expect(frame.startsWith('data:image/png;base64,'), `${mood} frame`).toBe(true);
    }
  }
});

test('collar badge hues come from the shared mood palette', () => {
  for (const mood of MOODS) {
    expect(catAnimated.moods[mood].collar, mood).toBe(MOOD_COLLARS[mood]);
  }
});

test('per-mood fps is a sane playback rate', () => {
  for (const mood of MOODS) {
    const fps = catAnimated.moods[mood].fps;
    expect(fps, mood).toBeGreaterThanOrEqual(1);
    expect(fps, mood).toBeLessThanOrEqual(24);
  }
});
