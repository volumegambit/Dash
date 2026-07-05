import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import { CompanionPet, PET_REGISTRY, PetThumbnail } from './index.js';

test('registry has both pets keyed by kind', () => {
  expect(PET_REGISTRY.cat.kind).toBe('cat');
  expect(PET_REGISTRY['red-panda'].kind).toBe('red-panda');
});

test('CompanionPet renders the selected pet and reflects mood via the working pulse', () => {
  const { container } = render(<CompanionPet kind="cat" statuses={['working']} />);
  expect(container.querySelector('title')?.textContent).toBe('Cat');
  expect(container.querySelectorAll('.companion-pulse').length).toBe(1);
});

test('the red panda renders as a frame-based animated pet', () => {
  const { container } = render(<CompanionPet kind="red-panda" statuses={['working']} />);
  expect(container.querySelector('svg')).toBeNull();
  const img = screen.getByRole('img', { name: 'Red panda' }).querySelector('img');
  expect(img?.src.startsWith('data:image/png;base64,')).toBe(true);
});

test('unknown kind falls back to the default pet', () => {
  // @ts-expect-error deliberately invalid kind
  render(<CompanionPet kind="dinosaur" statuses={[]} />);
  expect(screen.getByRole('img', { name: 'Red panda' })).toBeTruthy();
});

test('PetThumbnail renders the idle pet (never pulses)', () => {
  const { container } = render(<PetThumbnail kind="red-panda" />);
  expect(container.querySelectorAll('.companion-pulse').length).toBe(0);
  expect(screen.getByRole('img', { name: 'Red panda' })).toBeTruthy();
});
