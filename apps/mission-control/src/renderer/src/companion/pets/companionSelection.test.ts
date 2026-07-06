import { expect, test } from 'vitest';
import { parseCompanionSelection, serializeCompanionSelection } from './companionSelection.js';
import { DEFAULT_PET } from './kinds.js';

test('a valid pet id parses as a pet selection', () => {
  expect(parseCompanionSelection('cat')).toEqual({ type: 'pet', pet: 'cat' });
});

test('a valid crew id parses as a crew selection', () => {
  expect(parseCompanionSelection('crew:kitchen')).toEqual({ type: 'crew', crew: 'kitchen' });
});

test('an unknown value falls back to the default pet', () => {
  expect(parseCompanionSelection('nope')).toEqual({ type: 'pet', pet: DEFAULT_PET });
  expect(parseCompanionSelection(null)).toEqual({ type: 'pet', pet: DEFAULT_PET });
  expect(parseCompanionSelection('crew:not-a-crew')).toEqual({ type: 'pet', pet: DEFAULT_PET });
});

test('old persisted pet values still parse unchanged (backward compat)', () => {
  expect(parseCompanionSelection('red-panda')).toEqual({ type: 'pet', pet: 'red-panda' });
  expect(parseCompanionSelection('wok-uncle')).toEqual({ type: 'pet', pet: 'wok-uncle' });
});

test('a bare pet id that is also a crew member parses as the pet', () => {
  // 'waiter' is a wait-crew member but also a standalone pet id.
  expect(parseCompanionSelection('waiter')).toEqual({ type: 'pet', pet: 'waiter' });
});

test('serialize round-trips both selection kinds', () => {
  expect(serializeCompanionSelection({ type: 'pet', pet: 'cat' })).toBe('cat');
  expect(serializeCompanionSelection({ type: 'crew', crew: 'office' })).toBe('crew:office');
});

test('serialize then parse is identity', () => {
  const cases = [
    { type: 'pet' as const, pet: 'cat' as const },
    { type: 'crew' as const, crew: 'fire' as const },
  ];
  for (const c of cases) {
    expect(parseCompanionSelection(serializeCompanionSelection(c))).toEqual(c);
  }
});
