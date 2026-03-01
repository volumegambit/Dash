import { describe, expect, it } from 'vitest';
import { generateToken } from './keygen.js';

describe('generateToken', () => {
  it('returns a base64url string', () => {
    const token = generateToken();
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(0);
    // base64url characters only
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('returns unique values on each call', () => {
    const tokens = new Set(Array.from({ length: 10 }, () => generateToken()));
    expect(tokens.size).toBe(10);
  });

  it('respects custom byte length', () => {
    const short = generateToken(8);
    const long = generateToken(64);
    // base64url encodes 3 bytes → 4 chars, so 8 bytes → ~11 chars, 64 bytes → ~86 chars
    expect(short.length).toBeLessThan(long.length);
  });

  it('defaults to 32 bytes (43 base64url chars)', () => {
    const token = generateToken();
    // 32 bytes → ceil(32/3)*4 = 43 base64url chars
    expect(token.length).toBe(43);
  });
});
