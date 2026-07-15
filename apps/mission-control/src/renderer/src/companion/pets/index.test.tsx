import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import { PET_REGISTRY, PetThumbnail } from './index.js';

test('registry has every squad-member pet keyed by kind', () => {
  expect(PET_REGISTRY['sous-chef'].kind).toBe('sous-chef');
  expect(PET_REGISTRY.boss.kind).toBe('boss');
  expect(PET_REGISTRY.waiter.kind).toBe('waiter');
  expect(PET_REGISTRY.sergeant.kind).toBe('sergeant');
  expect(PET_REGISTRY['fire-dalmatian'].kind).toBe('fire-dalmatian');
});

test('retired standalone pets are gone from the registry', () => {
  const kinds = Object.keys(PET_REGISTRY);
  expect(kinds).not.toContain('cat');
  expect(kinds).not.toContain('red-panda');
  expect(kinds).not.toContain('wizard');
});

test('pets render frame-based animation from data-URI frames', () => {
  render(<PetThumbnail kind="sous-chef" />);
  const img = screen.getByRole('img', { name: 'Sous Chef' }).querySelector('img');
  expect(img?.src.startsWith('data:image/png;base64,')).toBe(true);
});

test('PetThumbnail renders the idle mood preview', () => {
  render(<PetThumbnail kind="boss" />);
  expect(screen.getByRole('img', { name: 'Boss' })).toBeTruthy();
  expect(screen.getByTestId('collar-dot').style.background).toBe('rgb(154, 160, 166)');
});
