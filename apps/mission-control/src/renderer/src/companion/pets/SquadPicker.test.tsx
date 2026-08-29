import { fireEvent, render } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { SquadPicker } from './SquadPicker.js';
import { SQUAD_KINDS } from './squads.js';

test('renders one card per squad and no individual pet buttons', () => {
  const { getAllByRole, getByRole, queryByText } = render(
    <SquadPicker value="kitchen" onChange={() => {}} />,
  );
  expect(getAllByRole('button')).toHaveLength(SQUAD_KINDS.length);
  expect(getByRole('button', { name: /kitchen squad/i }).getAttribute('aria-pressed')).toBe('true');
  // No "Pets" section — squads are the only selectable unit.
  expect(queryByText(/^pets$/i)).toBeNull();
});

test('clicking a squad card calls onChange with the squad kind', () => {
  const onChange = vi.fn();
  const { getByRole } = render(<SquadPicker value="office" onChange={onChange} />);
  fireEvent.click(getByRole('button', { name: /kitchen squad/i }));
  expect(onChange).toHaveBeenCalledWith('kitchen');
});

test('marks only the selected squad as pressed', () => {
  const { getByRole } = render(<SquadPicker value="office" onChange={() => {}} />);
  expect(getByRole('button', { name: /office squad/i }).getAttribute('aria-pressed')).toBe('true');
  expect(getByRole('button', { name: /kitchen squad/i }).getAttribute('aria-pressed')).toBe(
    'false',
  );
});
