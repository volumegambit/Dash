import { expect, test } from 'vitest';
import { parseCompanionSelection } from './companionSelection.js';
import { DEFAULT_SQUAD } from './squads.js';

test('a bare squad id parses as that squad', () => {
  expect(parseCompanionSelection('kitchen')).toBe('kitchen');
  expect(parseCompanionSelection('gym')).toBe('gym');
});

test('a legacy crew-prefixed value parses as its squad (backward compat)', () => {
  expect(parseCompanionSelection('crew:kitchen')).toBe('kitchen');
  expect(parseCompanionSelection('crew:office')).toBe('office');
});

test('an unknown value falls back to the default squad', () => {
  expect(parseCompanionSelection('nope')).toBe(DEFAULT_SQUAD);
  expect(parseCompanionSelection(null)).toBe(DEFAULT_SQUAD);
  expect(parseCompanionSelection('')).toBe(DEFAULT_SQUAD);
  expect(parseCompanionSelection('crew:not-a-crew')).toBe(DEFAULT_SQUAD);
});

test('retired single-pet ids fall back to the default squad', () => {
  expect(parseCompanionSelection('red-panda')).toBe(DEFAULT_SQUAD);
  expect(parseCompanionSelection('wok-uncle')).toBe(DEFAULT_SQUAD);
  // Squad-member pet ids were also selectable individually once; they are
  // not squads either.
  expect(parseCompanionSelection('waiter')).toBe(DEFAULT_SQUAD);
});
