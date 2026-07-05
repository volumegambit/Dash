import { findCatalogPattern, globToRegex } from './catalog-filter.js';

describe('globToRegex', () => {
  it('matches a `*` wildcard anchored at both ends', () => {
    const re = globToRegex('claude-fable-*');
    expect(re.test('claude-fable-5')).toBe(true);
    expect(re.test('xclaude-fable-5')).toBe(false);
    expect(re.test('claude-fable-')).toBe(true);
  });

  it('escapes literal dots (gpt-4.1 does not match gpt-401)', () => {
    const re = globToRegex('gpt-4.1');
    expect(re.test('gpt-4.1')).toBe(true);
    expect(re.test('gpt-401')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(globToRegex('claude-opus-*').test('CLAUDE-OPUS-4')).toBe(true);
  });
});

describe('findCatalogPattern', () => {
  it('returns the tier-carrying entry on an allow match', () => {
    const entry = findCatalogPattern(
      { supportedPatterns: [{ pattern: 'claude-opus-*', tier: 0 }] },
      'claude-opus-4-8',
    );
    expect(entry).toEqual({ pattern: 'claude-opus-*', tier: 0 });
  });

  it('returns the first matching entry (order = specificity)', () => {
    const entry = findCatalogPattern(
      {
        supportedPatterns: [
          { pattern: 'kimi-k2.7*', tier: 1 },
          { pattern: 'kimi-k2*', tier: 4 },
        ],
      },
      'kimi-k2.7-code',
    );
    expect(entry).toEqual({ pattern: 'kimi-k2.7*', tier: 1 });
  });

  it('returns null when an excluded pattern matches even though an allow pattern also matches', () => {
    const entry = findCatalogPattern(
      {
        supportedPatterns: [{ pattern: 'gemini-*-flash*', tier: 1 }],
        excludedPatterns: ['gemini-*-tts*'],
      },
      'gemini-2.5-flash-tts',
    );
    expect(entry).toBeNull();
  });

  it('returns null with no allow match', () => {
    const entry = findCatalogPattern(
      { supportedPatterns: [{ pattern: 'claude-opus-*', tier: 0 }] },
      'gpt-4o',
    );
    expect(entry).toBeNull();
  });

  it('treats absent supportedPatterns/excludedPatterns as empty', () => {
    expect(findCatalogPattern({}, 'anything')).toBeNull();
    expect(findCatalogPattern({ excludedPatterns: ['x-*'] }, 'x-1')).toBeNull();
  });
});
