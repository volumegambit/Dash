import { validateSubdomainLabel } from './subdomain.js';

describe('validateSubdomainLabel', () => {
  it('accepts a plain DNS-safe label', () => {
    expect(validateSubdomainLabel('alice-mbp')).toBe(true);
    expect(validateSubdomainLabel('a')).toBe(true);
    expect(validateSubdomainLabel('gw1')).toBe(true);
    expect(validateSubdomainLabel('a'.repeat(63))).toBe(true);
  });

  it('rejects empty and over-length labels', () => {
    expect(validateSubdomainLabel('')).toBe(false);
    expect(validateSubdomainLabel('a'.repeat(64))).toBe(false);
  });

  it('rejects uppercase and illegal characters', () => {
    expect(validateSubdomainLabel('Alice')).toBe(false);
    expect(validateSubdomainLabel('alice_mbp')).toBe(false);
    expect(validateSubdomainLabel('alice.mbp')).toBe(false);
    expect(validateSubdomainLabel('alice mbp')).toBe(false);
  });

  it('rejects leading/trailing hyphens', () => {
    expect(validateSubdomainLabel('-alice')).toBe(false);
    expect(validateSubdomainLabel('alice-')).toBe(false);
    expect(validateSubdomainLabel('-')).toBe(false);
  });

  it('rejects reserved words', () => {
    for (const r of ['www', 'api', 'admin', 'relay', 'health', 'gw']) {
      expect(validateSubdomainLabel(r)).toBe(false);
    }
  });
});
