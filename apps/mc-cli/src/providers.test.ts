import { describe, expect, it } from 'vitest';
import { PROVIDER_METAS, findProvider } from './providers.js';

describe('PROVIDER_METAS', () => {
  it('has entries for anthropic, openai, google', () => {
    const ids = PROVIDER_METAS.map((p) => p.id);
    expect(ids).toContain('anthropic');
    expect(ids).toContain('openai');
    expect(ids).toContain('google');
  });

  it('each entry has required fields', () => {
    for (const meta of PROVIDER_METAS) {
      expect(meta.secretKey).toBeTruthy();
      expect(meta.consoleUrl).toMatch(/^https:\/\//);
      expect(meta.apiKeysUrl).toMatch(/^https:\/\//);
      expect(meta.steps.length).toBeGreaterThan(0);
    }
  });
});

describe('findProvider', () => {
  it('finds by exact id', () => {
    expect(findProvider('anthropic')?.id).toBe('anthropic');
  });

  it('finds by partial name (case-insensitive)', () => {
    expect(findProvider('gemini')?.id).toBe('google');
  });

  it('returns undefined for unknown input', () => {
    expect(findProvider('unknown-xyz')).toBeUndefined();
  });
});
