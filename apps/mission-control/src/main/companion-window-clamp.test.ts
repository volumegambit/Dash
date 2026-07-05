// @vitest-environment node
import { clampToVisible } from './companion-window-clamp.js';

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
