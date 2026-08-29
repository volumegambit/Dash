import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { AnimatedPixelPet } from './AnimatedPixelPet.js';
import type { AnimatedPetSprite } from './types.js';

const f = (n: string): string => `data:image/png;base64,${n}`;

const sprite: AnimatedPetSprite = {
  kind: 'baker',
  name: 'Test pet',
  moods: {
    idle: { frames: [f('idle0'), f('idle1'), f('idle2')], fps: 10, collar: '#9aa0a6' },
    working: { frames: [f('run0'), f('run1')], fps: 10, collar: '#3da5d9' },
    needs: { frames: [f('sit0')], collar: '#f5c518' },
    done: { frames: [f('jump0'), f('jump1')], fps: 10, collar: '#34c759' },
    error: { frames: [f('mad0'), f('mad1')], fps: 10, collar: '#f87171' },
  },
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function currentSrc(): string | undefined {
  return screen.getByRole('img', { name: 'Test pet' }).querySelector('img')?.src;
}

test('renders the first frame and is labeled with the pet name', () => {
  render(<AnimatedPixelPet sprite={sprite} mood="idle" />);
  expect(currentSrc()).toBe(f('idle0'));
});

test('advances frames on the mood fps clock and wraps around', () => {
  render(<AnimatedPixelPet sprite={sprite} mood="idle" />);
  act(() => vi.advanceTimersByTime(100));
  expect(currentSrc()).toBe(f('idle1'));
  act(() => vi.advanceTimersByTime(200));
  expect(currentSrc()).toBe(f('idle0'));
});

test('switching mood restarts playback at the new animation frame 0', () => {
  const { rerender } = render(<AnimatedPixelPet sprite={sprite} mood="idle" />);
  act(() => vi.advanceTimersByTime(200));
  expect(currentSrc()).toBe(f('idle2'));
  rerender(<AnimatedPixelPet sprite={sprite} mood="error" />);
  expect(currentSrc()).toBe(f('mad0'));
  act(() => vi.advanceTimersByTime(100));
  expect(currentSrc()).toBe(f('mad1'));
});

test('a single-frame mood renders statically without a timer', () => {
  render(<AnimatedPixelPet sprite={sprite} mood="needs" />);
  expect(vi.getTimerCount()).toBe(0);
  act(() => vi.advanceTimersByTime(1000));
  expect(currentSrc()).toBe(f('sit0'));
});

test('shows the mood collar hue as a badge dot', () => {
  render(<AnimatedPixelPet sprite={sprite} mood="done" />);
  expect(screen.getByTestId('collar-dot').style.background).toBe('rgb(52, 199, 89)');
});

test('honors prefers-reduced-motion by freezing on the first frame', () => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockReturnValue({ matches: true, media: '(prefers-reduced-motion: reduce)' }),
  );
  try {
    render(<AnimatedPixelPet sprite={sprite} mood="idle" />);
    expect(vi.getTimerCount()).toBe(0);
    act(() => vi.advanceTimersByTime(500));
    expect(currentSrc()).toBe(f('idle0'));
  } finally {
    vi.unstubAllGlobals();
  }
});

test('the timer is cleaned up on unmount', () => {
  const { unmount } = render(<AnimatedPixelPet sprite={sprite} mood="idle" />);
  expect(vi.getTimerCount()).toBe(1);
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});
