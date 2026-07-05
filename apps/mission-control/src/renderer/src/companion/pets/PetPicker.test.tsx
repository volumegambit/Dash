import { fireEvent, render } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { PetPicker } from './PetPicker.js';

test('renders a button per pet and marks the selected one', () => {
  const { getByRole } = render(<PetPicker value="red-panda" onChange={() => {}} />);
  expect(getByRole('button', { name: /red panda/i }).getAttribute('aria-pressed')).toBe('true');
  expect(getByRole('button', { name: /cat/i }).getAttribute('aria-pressed')).toBe('false');
});

test('clicking a pet calls onChange with its kind', () => {
  const onChange = vi.fn();
  const { getByRole } = render(<PetPicker value="red-panda" onChange={onChange} />);
  fireEvent.click(getByRole('button', { name: /cat/i }));
  expect(onChange).toHaveBeenCalledWith('cat');
});
