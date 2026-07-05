import { expect, test } from 'vitest';
import { PET_REGISTRY } from './index.js';
import { PET_KINDS } from './kinds.js';
import type { Mood } from './types.js';
import { MOOD_COLLARS } from './types.js';

const MOODS: Mood[] = ['idle', 'working', 'needs', 'done', 'error'];

test('every selectable kind has a registry sprite with a matching kind', () => {
  for (const kind of PET_KINDS) {
    expect(PET_REGISTRY[kind]?.kind, kind).toBe(kind);
  }
});

test.each(Object.keys(PET_REGISTRY))(
  '%s defines five animated moods of PNG data-URI frames',
  (kind) => {
    const sprite = PET_REGISTRY[kind as keyof typeof PET_REGISTRY];
    for (const mood of MOODS) {
      const { frames } = sprite.moods[mood];
      expect(frames.length, `${kind}.${mood}`).toBeGreaterThan(1);
      for (const frame of frames) {
        expect(frame.startsWith('data:image/png;base64,'), `${kind}.${mood} frame`).toBe(true);
      }
    }
  },
);

test.each(Object.keys(PET_REGISTRY))('%s uses the shared collar palette and sane fps', (kind) => {
  const sprite = PET_REGISTRY[kind as keyof typeof PET_REGISTRY];
  for (const mood of MOODS) {
    expect(sprite.moods[mood].collar, `${kind}.${mood}`).toBe(MOOD_COLLARS[mood]);
    const fps = sprite.moods[mood].fps;
    expect(fps, `${kind}.${mood}`).toBeGreaterThanOrEqual(1);
    expect(fps, `${kind}.${mood}`).toBeLessThanOrEqual(24);
  }
});
