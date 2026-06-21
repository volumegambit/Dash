import { validateProviderCatalog } from './provider-catalog.js';

function minimalRaw(): Record<string, unknown> {
  return {
    id: 'acme',
    label: 'Acme',
    credentialPrefix: 'acme-api-key',
    baseUrl: 'https://api.acme.test',
    api: 'openai-completions',
    models: [{ id: 'acme-large', contextWindow: 128000, maxTokens: 8192 }],
  };
}

describe('validateProviderCatalog', () => {
  it('parses a minimal valid catalog', () => {
    const cat = validateProviderCatalog(minimalRaw());
    expect(cat.id).toBe('acme');
    expect(cat.label).toBe('Acme');
    expect(cat.credentialPrefix).toBe('acme-api-key');
    expect(cat.baseUrl).toBe('https://api.acme.test');
    expect(cat.api).toBe('openai-completions');
    expect(cat.models).toEqual([{ id: 'acme-large', contextWindow: 128000, maxTokens: 8192 }]);
  });

  it('accepts the anthropic-messages api', () => {
    const cat = validateProviderCatalog({ ...minimalRaw(), api: 'anthropic-messages' });
    expect(cat.api).toBe('anthropic-messages');
  });

  it('preserves recognized optional model metadata', () => {
    const cat = validateProviderCatalog({
      ...minimalRaw(),
      models: [
        {
          id: 'm',
          name: 'Model',
          contextWindow: 1000,
          maxTokens: 100,
          reasoning: true,
          input: ['text', 'image'],
          cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1.5 },
          headers: { 'x-beta': 'on' },
          compat: { foo: 'bar' },
        },
      ],
    });
    const m = cat.models[0];
    expect(m.name).toBe('Model');
    expect(m.reasoning).toBe(true);
    expect(m.input).toEqual(['text', 'image']);
    expect(m.cost).toEqual({ input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1.5 });
    expect(m.headers).toEqual({ 'x-beta': 'on' });
    expect(m.compat).toEqual({ foo: 'bar' });
  });

  it('preserves recognized optional top-level fields', () => {
    const cat = validateProviderCatalog({
      ...minimalRaw(),
      dynamicModels: true,
      dynamicModelDefaults: { contextWindow: 8000, maxTokens: 1024 },
      placeholderKey: 'local',
    });
    expect(cat.dynamicModels).toBe(true);
    expect(cat.dynamicModelDefaults).toEqual({ contextWindow: 8000, maxTokens: 1024 });
    expect(cat.placeholderKey).toBe('local');
  });

  it('drops unknown top-level fields', () => {
    const cat = validateProviderCatalog({ ...minimalRaw(), futureField: 1 });
    expect((cat as unknown as Record<string, unknown>).futureField).toBeUndefined();
  });

  it('throws on non-object input', () => {
    expect(() => validateProviderCatalog([])).toThrow(/object/);
    expect(() => validateProviderCatalog(null)).toThrow(/object/);
    expect(() => validateProviderCatalog('x')).toThrow(/object/);
  });

  it('throws on a non-kebab-case id', () => {
    expect(() => validateProviderCatalog({ ...minimalRaw(), id: 'Acme' })).toThrow(/kebab-case/);
    expect(() => validateProviderCatalog({ ...minimalRaw(), id: 'a_b' })).toThrow(/kebab-case/);
    expect(() => validateProviderCatalog({ ...minimalRaw(), id: 42 })).toThrow(/kebab-case/);
  });

  it('throws when label is not a string', () => {
    expect(() => validateProviderCatalog({ ...minimalRaw(), label: 1 })).toThrow(/label/);
  });

  it('throws when credentialPrefix is not a string', () => {
    expect(() => validateProviderCatalog({ ...minimalRaw(), credentialPrefix: 1 })).toThrow(
      /credentialPrefix/,
    );
  });

  it('throws when baseUrl is not a string', () => {
    expect(() => validateProviderCatalog({ ...minimalRaw(), baseUrl: 1 })).toThrow(/baseUrl/);
  });

  it('throws on an invalid api value', () => {
    expect(() => validateProviderCatalog({ ...minimalRaw(), api: 'grpc' })).toThrow(/api/);
  });

  it('throws when models is missing or not an array', () => {
    const { models: _drop, ...noModels } = minimalRaw();
    expect(() => validateProviderCatalog(noModels)).toThrow(/models/);
    expect(() => validateProviderCatalog({ ...minimalRaw(), models: 'x' })).toThrow(/models/);
  });

  it('throws when models is an empty array', () => {
    expect(() => validateProviderCatalog({ ...minimalRaw(), models: [] })).toThrow(/non-empty/);
  });

  it('throws when a model is not an object', () => {
    expect(() => validateProviderCatalog({ ...minimalRaw(), models: ['x'] })).toThrow(/model/);
  });

  it('throws when a model id is not a string', () => {
    expect(() =>
      validateProviderCatalog({
        ...minimalRaw(),
        models: [{ id: 1, contextWindow: 1, maxTokens: 1 }],
      }),
    ).toThrow(/id/);
  });

  it('throws when contextWindow is not a number', () => {
    expect(() =>
      validateProviderCatalog({
        ...minimalRaw(),
        models: [{ id: 'm', contextWindow: 'big', maxTokens: 1 }],
      }),
    ).toThrow(/contextWindow/);
  });

  it('throws when maxTokens is not a number', () => {
    expect(() =>
      validateProviderCatalog({
        ...minimalRaw(),
        models: [{ id: 'm', contextWindow: 1, maxTokens: 'lots' }],
      }),
    ).toThrow(/maxTokens/);
  });

  it('does not pollute Object.prototype via __proto__ keys', () => {
    const cat = validateProviderCatalog({
      ...minimalRaw(),
      ['__proto__']: { polluted: true },
      constructor: { x: 1 },
    });
    expect((cat as unknown as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect((Object.prototype as unknown as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('does not return the raw object (reconstructs field-by-field)', () => {
    const raw = minimalRaw();
    const cat = validateProviderCatalog(raw);
    expect(cat).not.toBe(raw);
    expect(cat.models).not.toBe(raw.models);
  });
});
