import { render } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CELL, CompanionTree, LEAF_SLOTS, TREE_GRID, TREE_PALETTE } from './CompanionTree.js';
import { MAX_LEAVES } from './leaves.js';

test('grid is rectangular and uses only palette characters', () => {
  const width = TREE_GRID[0].length;
  for (const row of TREE_GRID) {
    expect(row.length).toBe(width);
    for (const ch of row) {
      if (ch !== '.') expect(TREE_PALETTE[ch]).toBeDefined();
    }
  }
});

test('grid is 4x the old 8px resolution (2px cells on the 152x184 canvas)', () => {
  expect(CELL).toBe(2);
  expect(TREE_GRID[0].length).toBe(76); // 152 / 2
  expect(TREE_GRID.length).toBe(92); // 184 / 2
});

test('has at least 8 leaf slots, all within the canvas', () => {
  expect(LEAF_SLOTS.length).toBeGreaterThanOrEqual(8);
  expect(LEAF_SLOTS.length).toBeGreaterThanOrEqual(MAX_LEAVES);
  for (const s of LEAF_SLOTS) {
    expect(s.x).toBeGreaterThanOrEqual(0);
    expect(s.x).toBeLessThan(152);
    expect(s.y).toBeGreaterThanOrEqual(0);
    expect(s.y).toBeLessThan(184);
  }
});

test('renders one status leaf per active status and pulses working leaves', () => {
  const { container } = render(<CompanionTree statuses={['working', 'error']} />);
  expect(container.querySelectorAll('.companion-pulse').length).toBe(1); // working pulses
  const svg = container.querySelector('svg');
  expect(svg?.getAttribute('viewBox')).toBe('0 0 152 184');
});

// Status -> leaf mapping behavior (retained from the original sprite tests).
test('renders the resting palette when there are no statuses', () => {
  const html = renderToStaticMarkup(<CompanionTree statuses={[]} />);
  expect(html).toContain('<svg');
  expect(html).toContain('#2f3a30'); // rest leaf fill
  expect(html).not.toContain('#3da5d9'); // no working-leaf color at rest
});

test('colors the first leaf for a working session and adds the pulse class', () => {
  const html = renderToStaticMarkup(<CompanionTree statuses={['working']} />);
  expect(html).toContain('#3da5d9'); // working leaf fill
  expect(html).toContain('companion-pulse');
});
