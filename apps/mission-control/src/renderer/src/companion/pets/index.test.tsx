import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import { CompanionPet, PET_REGISTRY, PetThumbnail } from './index.js';

test('registry has every pet keyed by kind', () => {
  expect(PET_REGISTRY.cat.kind).toBe('cat');
  expect(PET_REGISTRY.dog.kind).toBe('dog');
  expect(PET_REGISTRY.pig.kind).toBe('pig');
  expect(PET_REGISTRY.rabbit.kind).toBe('rabbit');
  expect(PET_REGISTRY['red-panda'].kind).toBe('red-panda');
});

test('CompanionPet renders the selected pet with the aggregate-mood collar dot', () => {
  render(<CompanionPet kind="cat" statuses={['working']} />);
  expect(screen.getByRole('img', { name: 'Cat' })).toBeTruthy();
  expect(screen.getByTestId('collar-dot').style.background).toBe('rgb(61, 165, 217)');
});

test('pets render frame-based animation from data-URI frames', () => {
  render(<CompanionPet kind="red-panda" statuses={['working']} />);
  const img = screen.getByRole('img', { name: 'Red panda' }).querySelector('img');
  expect(img?.src.startsWith('data:image/png;base64,')).toBe(true);
});

test('unknown kind falls back to the default pet', () => {
  // @ts-expect-error deliberately invalid kind
  render(<CompanionPet kind="dinosaur" statuses={[]} />);
  expect(screen.getByRole('img', { name: 'Red panda' })).toBeTruthy();
});

test('PetThumbnail renders the idle mood preview', () => {
  render(<PetThumbnail kind="cat" />);
  expect(screen.getByRole('img', { name: 'Cat' })).toBeTruthy();
  expect(screen.getByTestId('collar-dot').style.background).toBe('rgb(154, 160, 166)');
});
