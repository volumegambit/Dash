import { expect, test } from 'vitest';
import { gridRects } from './gridRects.js';

const palette = { a: '#f00', b: '#0f0' };

test('merges horizontal runs of the same char and skips transparent/unknown', () => {
  const rects = gridRects(['..aa', 'bbb.'], palette, 2);
  expect(rects).toEqual([
    { x: 4, y: 0, width: 4, height: 2, fill: '#f00' },
    { x: 0, y: 2, width: 6, height: 2, fill: '#0f0' },
  ]);
});

test('a transparent cell breaks a run', () => {
  const rects = gridRects(['a.a'], { a: '#f00' }, 2);
  expect(rects).toHaveLength(2);
  expect(rects[0]).toEqual({ x: 0, y: 0, width: 2, height: 2, fill: '#f00' });
  expect(rects[1]).toEqual({ x: 4, y: 0, width: 2, height: 2, fill: '#f00' });
});

test('chars absent from the palette are treated as transparent', () => {
  expect(gridRects(['aZa'], { a: '#f00' }, 2)).toHaveLength(2);
});
