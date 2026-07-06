import { fireEvent, render } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { PetPicker } from './PetPicker.js';
import { CREW_KINDS } from './crews.js';
import { PET_KINDS } from './kinds.js';

test('renders a button per pet and per crew, marking the selected pet', () => {
  const { getByRole, getAllByRole } = render(<PetPicker value="red-panda" onChange={() => {}} />);
  // One button per pet plus one card per crew.
  expect(getAllByRole('button')).toHaveLength(PET_KINDS.length + CREW_KINDS.length);
  expect(getByRole('button', { name: /red panda/i }).getAttribute('aria-pressed')).toBe('true');
  // Pet buttons' accessible name repeats the pet name (thumbnail + label).
  expect(getByRole('button', { name: /^cat cat$/i }).getAttribute('aria-pressed')).toBe('false');
});

test('clicking a pet calls onChange with its kind', () => {
  const onChange = vi.fn();
  const { getByRole } = render(<PetPicker value="red-panda" onChange={onChange} />);
  fireEvent.click(getByRole('button', { name: /^cat cat$/i }));
  expect(onChange).toHaveBeenCalledWith('cat');
});

test('clicking a crew card calls onChange with the crew selection string', () => {
  const onChange = vi.fn();
  const { getByRole } = render(<PetPicker value="red-panda" onChange={onChange} />);
  fireEvent.click(getByRole('button', { name: /kitchen crew/i }));
  expect(onChange).toHaveBeenCalledWith('crew:kitchen');
});

test('marks the selected crew as pressed', () => {
  const { getByRole } = render(<PetPicker value="crew:office" onChange={() => {}} />);
  expect(getByRole('button', { name: /office crew/i }).getAttribute('aria-pressed')).toBe('true');
  // No pet should be pressed when a crew is selected.
  expect(getByRole('button', { name: /red panda/i }).getAttribute('aria-pressed')).toBe('false');
});
