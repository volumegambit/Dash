import { render } from '@testing-library/react';
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

test('unknown kind falls back to the default pet', () => {
  // @ts-expect-error deliberately invalid kind
  const { container } = render(<CompanionPet kind="dinosaur" statuses={[]} />);
  expect(container.querySelector('title')?.textContent).toBe('Red panda');
});

test('PetThumbnail renders the idle pet (never pulses)', () => {
  const { container } = render(<PetThumbnail kind="red-panda" />);
  expect(container.querySelectorAll('.companion-pulse').length).toBe(0);
});
