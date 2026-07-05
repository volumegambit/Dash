import { expect, test } from 'vitest';
import { cat } from './cat.js';
import type { Mood } from './types.js';

const MOODS: Mood[] = ['idle', 'working', 'needs', 'done', 'error'];
const COLLAR: Record<Mood, string> = {
  idle: '#9aa0a6',
  working: '#3da5d9',
  needs: '#f5c518',
  done: '#34c759',
  error: '#f87171',
};

test('grid is rectangular and within size bounds', () => {
  const width = cat.grid[0].length;
  expect(width).toBeGreaterThanOrEqual(48);
  expect(width).toBeLessThanOrEqual(64);
  expect(cat.grid.length).toBeGreaterThanOrEqual(48);
  expect(cat.grid.length).toBeLessThanOrEqual(72);
  for (const row of cat.grid) expect(row.length).toBe(width);
});

test("base grid uses only palette chars plus '.' and the reserved 'C'", () => {
  expect(cat.palette.C).toBeUndefined();
  for (const row of cat.grid) {
    for (const ch of row) {
      if (ch === '.' || ch === 'C') continue;
      expect(cat.palette[ch]).toBeDefined();
    }
  }
});

test('has a collar band and each mood maps to the right collar + pulse', () => {
  expect(cat.grid.some((r) => r.includes('C'))).toBe(true);
  for (const m of MOODS) {
    expect(cat.moods[m].collar).toBe(COLLAR[m]);
    for (const ch of Object.values(cat.moods[m].cells)) {
      if (ch === '.' || ch === 'C') continue;
      expect(cat.palette[ch]).toBeDefined();
    }
  }
  expect(cat.moods.working.pulse).toBe(true);
  expect(cat.moods.idle.pulse).toBeFalsy();
});
