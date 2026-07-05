import { render } from '@testing-library/react';
import { expect, test } from 'vitest';
import { PixelPet, composeGrid } from './PixelPet.js';
import type { PetSprite } from './types.js';

const fixture: PetSprite = {
  kind: 'cat',
  name: 'Fixture',
  grid: ['CC', 'EE'],
  palette: { E: '#000' },
  moods: {
    idle: { collar: '#9aa0a6', cells: {} },
    working: { collar: '#3da5d9', cells: {}, pulse: true },
    needs: { collar: '#f5c518', cells: {} },
    done: { collar: '#34c759', cells: {} },
    error: { collar: '#f87171', cells: { '0,1': '.' } },
  },
};

test('composeGrid resolves the collar char to the mood color and applies overlay cells', () => {
  const { palette } = composeGrid(fixture, 'working');
  expect(palette.C).toBe('#3da5d9');
  const { grid } = composeGrid(fixture, 'error');
  expect(grid[1]).toBe('.E'); // '0,1' overlaid with transparent
});

test('renders a crisp svg sized to the grid and pulses only when the mood pulses', () => {
  const { container, rerender } = render(<PixelPet sprite={fixture} mood="working" size={64} />);
  const svg = container.querySelector('svg');
  expect(svg?.getAttribute('viewBox')).toBe('0 0 4 4'); // 2 cells * CELL(2)
  expect(svg?.getAttribute('shape-rendering')).toBe('crispEdges');
  expect(container.querySelectorAll('.companion-pulse').length).toBe(1);
  // collar row renders in the working color
  expect(container.querySelector('rect[fill="#3da5d9"]')).not.toBeNull();
  rerender(<PixelPet sprite={fixture} mood="idle" size={64} />);
  expect(container.querySelectorAll('.companion-pulse').length).toBe(0);
});
