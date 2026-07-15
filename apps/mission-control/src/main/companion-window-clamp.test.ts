// @vitest-environment node
import { anchoredResize, clampToVisible, windowSizeFor } from './companion-window-clamp.js';

const primary = { bounds: { x: 0, y: 0, width: 1920, height: 1080 } };
const win = windowSizeFor(1);

test('keeps a position that is on-screen', () => {
  expect(clampToVisible({ x: 100, y: 100 }, [primary], win)).toEqual({ x: 100, y: 100 });
});

test('recenters a position stranded on an unplugged display', () => {
  const stranded = { x: 4000, y: 200 }; // was on a second monitor
  const out = clampToVisible(stranded, [primary], win);
  expect(out).toEqual({ x: (1920 - win.width) / 2, y: (1080 - win.height) / 2 });
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

test('windowSizeFor grows with the visible member count', () => {
  // 88px per member, 4px gaps, 24px side padding on each edge.
  expect(windowSizeFor(1)).toEqual({ width: 136, height: 200 });
  expect(windowSizeFor(2)).toEqual({ width: 228, height: 200 });
  expect(windowSizeFor(5)).toEqual({ width: 504, height: 200 });
});

test('side padding covers the speech bubble overhang beyond an edge member', () => {
  // A bubble is up to 132px wide, centered over an 88px member slot, so it
  // overhangs (132 - 88) / 2 = 22px past the slot on each side. The window
  // must pad at least that much or edge bubbles get clipped.
  const single = windowSizeFor(1);
  const sidePadding = (single.width - 88) / 2;
  expect(sidePadding).toBeGreaterThanOrEqual((132 - 88) / 2);
});

test('a full squad window clamps against its own (wider) size', () => {
  const fullWin = windowSizeFor(5);
  // A position that would be on-screen for the single-member window but
  // strands the wider full-squad window past the right edge should recenter.
  const nearRightEdge = { x: 1900, y: 100 };
  const clamped = clampToVisible(nearRightEdge, [primary], fullWin);
  expect(clamped).not.toEqual(nearRightEdge);
  expect(clamped.x).toBe((1920 - fullWin.width) / 2);
});

test('anchoredResize keeps the bottom-right corner fixed when growing', () => {
  const one = windowSizeFor(1);
  const five = windowSizeFor(5);
  const pos = { x: 1000, y: 800 };
  const next = anchoredResize(pos, one, five);
  // Bottom-right corner unchanged: right edge and bottom edge stay put.
  expect(next.x + five.width).toBe(pos.x + one.width);
  expect(next.y + five.height).toBe(pos.y + one.height);
  // Growing wider means the top-left x moves left.
  expect(next.x).toBeLessThan(pos.x);
});

test('anchoredResize keeps the bottom-right corner fixed when shrinking', () => {
  const one = windowSizeFor(1);
  const five = windowSizeFor(5);
  const pos = { x: 500, y: 800 };
  const next = anchoredResize(pos, five, one);
  expect(next.x + one.width).toBe(pos.x + five.width);
  expect(next.y + one.height).toBe(pos.y + five.height);
});
