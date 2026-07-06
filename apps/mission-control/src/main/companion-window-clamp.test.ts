// @vitest-environment node
import { anchoredResize, clampToVisible, windowSizeFor } from './companion-window-clamp.js';

const primary = { bounds: { x: 0, y: 0, width: 1920, height: 1080 } };
const win = { width: 140, height: 190 };

test('keeps a position that is on-screen', () => {
  expect(clampToVisible({ x: 100, y: 100 }, [primary], win)).toEqual({ x: 100, y: 100 });
});

test('recenters a position stranded on an unplugged display', () => {
  const stranded = { x: 4000, y: 200 }; // was on a second monitor
  const out = clampToVisible(stranded, [primary], win);
  expect(out).toEqual({ x: (1920 - 140) / 2, y: (1080 - 190) / 2 });
});

test('a barely-visible position (under 40px overlap) is recentered', () => {
  expect(clampToVisible({ x: 1919, y: 100 }, [primary], win)).not.toEqual({ x: 1919, y: 100 });
});

test('keeps a position on a secondary display', () => {
  const secondary = { bounds: { x: 1920, y: 0, width: 1920, height: 1080 } };
  expect(clampToVisible({ x: 2000, y: 100 }, [primary, secondary], win)).toEqual({
    x: 2000,
    y: 100,
  });
});

test('windowSizeFor: a single pet is the compact window', () => {
  expect(windowSizeFor('cat')).toEqual({ width: 140, height: 190 });
  // Old persisted / unknown values fall back to the pet window.
  expect(windowSizeFor('anything')).toEqual({ width: 140, height: 190 });
});

test('windowSizeFor: a crew is the wide fleet window', () => {
  const size = windowSizeFor('crew:kitchen');
  expect(size.width).toBeGreaterThan(400);
  expect(size.height).toBeGreaterThanOrEqual(190);
});

test('a crew window clamps against its own (wider) size', () => {
  const crewWin = windowSizeFor('crew:office');
  // A position that would be on-screen for the narrow pet window but strands
  // the wider crew window past the right edge should recenter.
  const nearRightEdge = { x: 1900, y: 100 };
  const clamped = clampToVisible(nearRightEdge, [primary], crewWin);
  expect(clamped).not.toEqual(nearRightEdge);
  expect(clamped.x).toBe((1920 - crewWin.width) / 2);
});

test('anchoredResize keeps the bottom-right corner fixed when growing', () => {
  const pet = windowSizeFor('cat');
  const crew = windowSizeFor('crew:kitchen');
  const pos = { x: 1000, y: 800 };
  const next = anchoredResize(pos, pet, crew);
  // Bottom-right corner unchanged: right edge and bottom edge stay put.
  expect(next.x + crew.width).toBe(pos.x + pet.width);
  expect(next.y + crew.height).toBe(pos.y + pet.height);
  // Growing wider means the top-left x moves left.
  expect(next.x).toBeLessThan(pos.x);
});

test('anchoredResize keeps the bottom-right corner fixed when shrinking', () => {
  const pet = windowSizeFor('cat');
  const crew = windowSizeFor('crew:kitchen');
  const pos = { x: 500, y: 800 };
  const next = anchoredResize(pos, crew, pet);
  expect(next.x + pet.width).toBe(pos.x + crew.width);
  expect(next.y + pet.height).toBe(pos.y + crew.height);
});
