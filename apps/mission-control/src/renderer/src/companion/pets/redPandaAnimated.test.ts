import { expect, test } from 'vitest';
import { cat } from './cat.js';
import { redPandaAnimated } from './redPandaAnimated.js';
import type { Mood } from './types.js';

const MOODS: Mood[] = ['idle', 'working', 'needs', 'done', 'error'];

test('defines all five moods with at least one PNG data-URI frame each', () => {
  for (const mood of MOODS) {
    const { frames } = redPandaAnimated.moods[mood];
    expect(frames.length, mood).toBeGreaterThan(0);
    for (const frame of frames) {
      expect(frame.startsWith('data:image/png;base64,'), `${mood} frame`).toBe(true);
    }
  }
});

test('every mood is genuinely animated (more than one frame)', () => {
  for (const mood of MOODS) {
    expect(redPandaAnimated.moods[mood].frames.length, mood).toBeGreaterThan(1);
  }
});

test('collar badge hues match the grid pets mood palette', () => {
  for (const mood of MOODS) {
    expect(redPandaAnimated.moods[mood].collar, mood).toBe(cat.moods[mood].collar);
  }
});

test('per-mood fps is a sane playback rate', () => {
  for (const mood of MOODS) {
    const fps = redPandaAnimated.moods[mood].fps;
    expect(fps, mood).toBeGreaterThanOrEqual(1);
    expect(fps, mood).toBeLessThanOrEqual(24);
  }
});
