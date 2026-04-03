import {
  SUPPORTED_MODELS,
  findSupportedModel,
  globToRegex,
  isModelSupported,
} from './supported-models.js';

describe('globToRegex', () => {
  it('converts simple wildcard', () => {
    const re = globToRegex('claude-sonnet-*');
    expect(re.test('claude-sonnet-4-20250514')).toBe(true);
    expect(re.test('claude-opus-4-20250514')).toBe(false);
  });

  it('matches exact string without wildcard', () => {
    const re = globToRegex('gpt-4o');
    expect(re.test('gpt-4o')).toBe(true);
    expect(re.test('gpt-4o-mini')).toBe(false);
    expect(re.test('gpt-4o-2024-05-13')).toBe(false);
  });

  it('escapes dots in model names', () => {
    const re = globToRegex('gpt-5.4-pro');
    expect(re.test('gpt-5.4-pro')).toBe(true);
    expect(re.test('gpt-524-pro')).toBe(false); // dot should not match any char
  });

  it('is case-insensitive', () => {
    const re = globToRegex('claude-opus-*');
    expect(re.test('Claude-Opus-4')).toBe(true);
  });
});

describe('isModelSupported', () => {
  // Anthropic models
  it.each([
    ['claude-opus-4-20250514', true],
    ['claude-sonnet-4-20250514', true],
    ['claude-haiku-4-5-20251001', true],
    ['claude-sonnet-4-20260101', true], // future version
  ])('anthropic/%s → %s', (modelId, expected) => {
    expect(isModelSupported('anthropic', modelId)).toBe(expected);
  });

  // OpenAI — allowed
  it.each([
    ['o3-pro', true],
    ['o3', true],
    ['o3-mini', true],
    ['o1', true],
    ['o1-pro', true],
    ['gpt-5.4-pro', true],
    ['gpt-5.4', true],
    ['gpt-5', true],
    ['gpt-5-mini', true],
    ['gpt-4o', true],
    ['gpt-4o-mini', true],
    ['gpt-4-turbo', true],
    ['gpt-4', true],
    ['gpt-4.1', true],
    ['gpt-4.1-mini', true],
    ['gpt-3.5-turbo', true],
  ])('openai/%s → %s', (modelId, expected) => {
    expect(isModelSupported('openai', modelId)).toBe(expected);
  });

  // OpenAI — filtered out
  it.each([
    ['text-embedding-3-large', false],
    ['text-embedding-ada-002', false],
    ['gpt-image-1.5', false],
    ['gpt-image-1-mini', false],
    ['dall-e-3', false],
    ['tts-1', false],
    ['whisper-1', false],
    ['gpt-4o-2024-05-13', false], // dated variant
    ['gpt-5.3-codex', false], // codex model
    ['gpt-5.4-nano', false], // nano model
    ['gpt-5.1-chat', false], // chat suffix duplicate
    ['chatgpt-image-latest', false],
    ['gpt-4o-realtime-preview', false],
    ['o4-mini-deep-research', false], // not in allow-list
  ])('openai/%s → %s', (modelId, expected) => {
    expect(isModelSupported('openai', modelId)).toBe(expected);
  });

  // Google — allowed
  it.each([
    ['gemini-2.0-flash', true],
    ['gemini-2.5-pro', true],
    ['gemini-1.5-flash', true],
  ])('google/%s → %s', (modelId, expected) => {
    expect(isModelSupported('google', modelId)).toBe(expected);
  });

  // Unknown provider
  it('rejects unknown providers', () => {
    expect(isModelSupported('unknown', 'some-model')).toBe(false);
  });
});

describe('findSupportedModel', () => {
  it('returns tier for matched model', () => {
    const result = findSupportedModel('anthropic', 'claude-opus-4-20250514');
    expect(result).not.toBeNull();
    expect(result!.tier).toBe(0);
  });

  it('returns higher tier for less capable models', () => {
    const opus = findSupportedModel('anthropic', 'claude-opus-4-20250514');
    const haiku = findSupportedModel('anthropic', 'claude-haiku-4-5-20251001');
    expect(opus!.tier).toBeLessThan(haiku!.tier);
  });

  it('returns null for unsupported model', () => {
    expect(findSupportedModel('openai', 'text-embedding-3-large')).toBeNull();
  });
});

describe('SUPPORTED_MODELS', () => {
  it('covers all hardcoded AVAILABLE_MODELS from deploy-options', () => {
    // These are the model IDs from deploy-options.ts AVAILABLE_MODELS
    const hardcoded = [
      { provider: 'anthropic', modelId: 'claude-opus-4-20250514' },
      { provider: 'anthropic', modelId: 'claude-sonnet-4-20250514' },
      { provider: 'anthropic', modelId: 'claude-haiku-4-5-20251001' },
      { provider: 'openai', modelId: 'gpt-4o' },
      { provider: 'openai', modelId: 'o3-mini' },
      { provider: 'google', modelId: 'gemini-2.0-flash' },
    ];

    for (const { provider, modelId } of hardcoded) {
      expect(isModelSupported(provider, modelId)).toBe(true);
    }
  });

  it('has no duplicate patterns', () => {
    const keys = SUPPORTED_MODELS.map((e) => `${e.provider}/${e.pattern}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
