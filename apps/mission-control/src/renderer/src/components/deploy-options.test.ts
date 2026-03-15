import { describe, expect, it } from 'vitest';
import { AVAILABLE_MODELS, AVAILABLE_TOOLS } from './deploy-options.js';

describe('AVAILABLE_MODELS', () => {
  it('all models use provider/model-id format', () => {
    for (const m of AVAILABLE_MODELS) {
      expect(m.value, `${m.value} must contain a slash`).toContain('/');
    }
  });

  it('all models have a provider field', () => {
    for (const m of AVAILABLE_MODELS) {
      expect(['anthropic', 'openai', 'google']).toContain(m.provider);
    }
  });

  it('all models have a secretKey field', () => {
    for (const m of AVAILABLE_MODELS) {
      expect(m.secretKey).toBeTruthy();
    }
  });

  it('includes Claude, GPT, and Gemini models', () => {
    const providers = new Set(AVAILABLE_MODELS.map((m) => m.provider));
    expect(providers.has('anthropic')).toBe(true);
    expect(providers.has('openai')).toBe(true);
    expect(providers.has('google')).toBe(true);
  });

  it('anthropic models use anthropic-api-key', () => {
    const anthropicModels = AVAILABLE_MODELS.filter((m) => m.provider === 'anthropic');
    for (const m of anthropicModels) {
      expect(m.secretKey).toBe('anthropic-api-key');
    }
  });
});

describe('AVAILABLE_TOOLS', () => {
  it('has at least one tool', () => {
    expect(AVAILABLE_TOOLS.length).toBeGreaterThanOrEqual(1);
  });

  it('every tool has a value and label', () => {
    for (const tool of AVAILABLE_TOOLS) {
      expect(tool.value).toBeTruthy();
      expect(tool.label).toBeTruthy();
    }
  });

  it('tool values are unique', () => {
    const values = AVAILABLE_TOOLS.map((t) => t.value);
    expect(new Set(values).size).toBe(values.length);
  });

  it('tool values use lowercase alphanumeric with underscores', () => {
    for (const tool of AVAILABLE_TOOLS) {
      expect(tool.value).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it('includes core PiAgent tools', () => {
    const values = AVAILABLE_TOOLS.map((t) => t.value);
    expect(values).toContain('bash');
    expect(values).toContain('read');
    expect(values).toContain('write');
    expect(values).toContain('edit');
    expect(values).toHaveLength(4);
  });
});
