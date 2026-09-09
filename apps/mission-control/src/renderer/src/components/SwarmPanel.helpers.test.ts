import { describe, expect, it } from 'vitest';
import { formatTokens, parseAllowedModels, parsePositiveInt } from './SwarmPanel.helpers.js';

describe('formatTokens', () => {
  it('formats compactly', () => {
    expect(formatTokens(842)).toBe('842');
    expect(formatTokens(12_345)).toBe('12.3k');
    expect(formatTokens(1_250_000)).toBe('1.3M');
  });
});

describe('parseAllowedModels', () => {
  it('trims, drops blanks, and de-duplicates preserving order', () => {
    expect(parseAllowedModels(' a , b ,, a, c ')).toEqual(['a', 'b', 'c']);
  });
  it('returns an empty array for a blank input', () => {
    expect(parseAllowedModels('   ,  ,')).toEqual([]);
    expect(parseAllowedModels('')).toEqual([]);
  });
});

describe('parsePositiveInt', () => {
  it('parses a positive integer', () => {
    expect(parsePositiveInt('8')).toBe(8);
    expect(parsePositiveInt('  24  ')).toBe(24);
  });
  it('returns undefined for blank / zero / negative / non-integer / non-numeric', () => {
    expect(parsePositiveInt('')).toBeUndefined();
    expect(parsePositiveInt('0')).toBeUndefined();
    expect(parsePositiveInt('-3')).toBeUndefined();
    expect(parsePositiveInt('2.5')).toBeUndefined();
    expect(parsePositiveInt('abc')).toBeUndefined();
  });
});
