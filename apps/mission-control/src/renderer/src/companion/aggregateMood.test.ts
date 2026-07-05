import { expect, test } from 'vitest';
import { aggregateMood } from './aggregateMood.js';

test('empty -> idle', () => {
  expect(aggregateMood([])).toBe('idle');
});

test('priority is error > needs > working > done', () => {
  expect(aggregateMood(['done', 'working', 'needs', 'error'])).toBe('error');
  expect(aggregateMood(['done', 'working', 'needs'])).toBe('needs');
  expect(aggregateMood(['done', 'working'])).toBe('working');
  expect(aggregateMood(['done', 'done'])).toBe('done');
});
