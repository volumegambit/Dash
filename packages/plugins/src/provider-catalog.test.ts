import type { ModelsFetchSpec } from '@dash/plugin-sdk';
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

  it('throws when credentialPrefix does not equal `${id}-api-key`', () => {
    expect(() =>
      validateProviderCatalog({ ...minimalRaw(), id: 'myllm', credentialPrefix: 'wrong-api-key' }),
    ).toThrow(/credentialPrefix must be "myllm-api-key" \(got "wrong-api-key"\)/);
  });

  it('accepts a credentialPrefix that equals `${id}-api-key`', () => {
    const cat = validateProviderCatalog({
      ...minimalRaw(),
      id: 'myllm',
      credentialPrefix: 'myllm-api-key',
    });
    expect(cat.id).toBe('myllm');
    expect(cat.credentialPrefix).toBe('myllm-api-key');
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

describe('validateProviderCatalog — phase-1 fields', () => {
  const base = {
    id: 'acme',
    label: 'Acme',
    credentialPrefix: 'acme-api-key',
    baseUrl: 'https://api.acme.dev',
    api: 'openai-completions',
    models: [{ id: 'acme-1', contextWindow: 128000, maxTokens: 8192 }],
  };

  it('accepts all nine pi-ai api shapes', () => {
    for (const api of [
      'openai-completions',
      'openai-responses',
      'azure-openai-responses',
      'openai-codex-responses',
      'anthropic-messages',
      'mistral-conversations',
      'bedrock-converse-stream',
      'google-generative-ai',
      'google-vertex',
    ]) {
      expect(validateProviderCatalog({ ...base, api }).api).toBe(api);
    }
  });

  it('accepts and returns a well-formed modelsFetch spec', () => {
    const cat = validateProviderCatalog({
      ...base,
      modelsFetch: {
        url: 'https://api.acme.dev/v1/models',
        auth: [{ header: 'x-api-key' }],
        listPath: 'data',
        idPath: 'id',
      },
    });
    const spec = cat.modelsFetch as ModelsFetchSpec;
    expect(spec.url).toBe('https://api.acme.dev/v1/models');
    expect(spec.auth).toEqual([{ header: 'x-api-key' }]);
  });

  it('throws on a modelsFetch spec missing listPath', () => {
    expect(() =>
      validateProviderCatalog({
        ...base,
        modelsFetch: { url: 'https://api.acme.dev/v1/models', auth: [], idPath: 'id' },
      }),
    ).toThrow(/listPath/);
  });

  it('throws on an auth rule carrying both header and queryParam', () => {
    expect(() =>
      validateProviderCatalog({
        ...base,
        modelsFetch: {
          url: 'https://api.acme.dev/v1/models',
          auth: [{ header: 'x-api-key', queryParam: 'key' }],
          listPath: 'data',
          idPath: 'id',
        },
      }),
    ).toThrow(/header or queryParam/);
  });

  it('accepts supportedPatterns and throws on a non-numeric tier', () => {
    expect(
      validateProviderCatalog({
        ...base,
        supportedPatterns: [{ pattern: 'acme-*', tier: 0 }],
      }).supportedPatterns,
    ).toEqual([{ pattern: 'acme-*', tier: 0 }]);
    expect(() =>
      validateProviderCatalog({ ...base, supportedPatterns: [{ pattern: 'acme-*', tier: 'a' }] }),
    ).toThrow(/tier/);
  });

  it('accepts reviewedAt as YYYY-MM-DD and throws otherwise', () => {
    expect(validateProviderCatalog({ ...base, reviewedAt: '2026-07-05' }).reviewedAt).toBe(
      '2026-07-05',
    );
    expect(() => validateProviderCatalog({ ...base, reviewedAt: 'yesterday' })).toThrow(
      /reviewedAt/,
    );
  });

  it('keeps well-formed ui hints and drops malformed ones', () => {
    expect(
      validateProviderCatalog({ ...base, ui: { keyConsoleUrl: 'https://acme.dev/keys' } }).ui,
    ).toEqual({ keyConsoleUrl: 'https://acme.dev/keys' });
    expect(validateProviderCatalog({ ...base, ui: 'nope' }).ui).toBeUndefined();
  });

  it('round-trips excludedPatterns', () => {
    expect(
      validateProviderCatalog({ ...base, excludedPatterns: ['gemini-*-tts*'] }).excludedPatterns,
    ).toEqual(['gemini-*-tts*']);
  });

  it('throws when excludedPatterns has an empty-string entry', () => {
    expect(() => validateProviderCatalog({ ...base, excludedPatterns: [''] })).toThrow(
      /excludedPatterns/,
    );
  });

  it('throws when excludedPatterns is not an array', () => {
    expect(() => validateProviderCatalog({ ...base, excludedPatterns: 'x' })).toThrow(
      /excludedPatterns/,
    );
  });

  it('round-trips ui.sortOrder', () => {
    expect(validateProviderCatalog({ ...base, ui: { sortOrder: 2 } }).ui).toEqual({ sortOrder: 2 });
  });

  it('throws when ui.sortOrder is not a finite number', () => {
    expect(() => validateProviderCatalog({ ...base, ui: { sortOrder: 'first' } })).toThrow(
      /sortOrder/,
    );
  });
});

describe('validateProviderCatalog — phase-2 modelsFetch variants + entryFilters', () => {
  const base = {
    id: 'acme',
    label: 'Acme',
    credentialPrefix: 'acme-api-key',
    baseUrl: 'https://api.acme.dev',
    api: 'openai-completions',
    models: [{ id: 'acme-1', contextWindow: 128000, maxTokens: 8192 }],
  };

  it('accepts an array modelsFetch and returns the variants in order, keeping whenKeyPrefix', () => {
    const cat = validateProviderCatalog({
      ...base,
      modelsFetch: [
        {
          whenKeyPrefix: 'eyJ',
          url: 'https://chatgpt.com/backend-api/codex/models?client_version=2.0.0',
          auth: [{ header: 'authorization', valuePrefix: 'Bearer ' }],
          listPath: 'models',
          idPath: 'slug',
          namePath: 'display_name',
        },
        {
          url: 'https://api.acme.dev/v1/models',
          auth: [{ header: 'authorization', valuePrefix: 'Bearer ' }],
          listPath: 'data',
          idPath: 'id',
        },
      ],
    });
    const variants = cat.modelsFetch as ModelsFetchSpec[];
    expect(Array.isArray(variants)).toBe(true);
    expect(variants[0]?.whenKeyPrefix).toBe('eyJ');
    expect(variants[0]?.idPath).toBe('slug');
    expect(variants[1]?.whenKeyPrefix).toBeUndefined();
    expect(variants[1]?.listPath).toBe('data');
  });

  it('still accepts a single-object modelsFetch (back-compat)', () => {
    const cat = validateProviderCatalog({
      ...base,
      modelsFetch: {
        url: 'https://api.acme.dev/v1/models',
        auth: [{ header: 'x-api-key' }],
        listPath: 'data',
        idPath: 'id',
      },
    });
    expect(Array.isArray(cat.modelsFetch)).toBe(false);
    expect((cat.modelsFetch as ModelsFetchSpec).url).toBe('https://api.acme.dev/v1/models');
  });

  it('accepts and returns well-formed entryFilters', () => {
    const cat = validateProviderCatalog({
      ...base,
      modelsFetch: {
        url: 'https://openrouter.ai/api/v1/models',
        auth: [{ header: 'authorization', valuePrefix: 'Bearer ' }],
        listPath: 'data',
        idPath: 'id',
        namePath: 'name',
        entryFilters: {
          arrayIncludes: [{ path: 'supported_parameters', value: 'tools' }],
          excludeIdSubstrings: [':'],
        },
      },
    });
    const spec = cat.modelsFetch as ModelsFetchSpec;
    expect(spec.entryFilters?.arrayIncludes).toEqual([
      { path: 'supported_parameters', value: 'tools' },
    ]);
    expect(spec.entryFilters?.excludeIdSubstrings).toEqual([':']);
  });

  it('throws on an entryFilters.arrayIncludes entry missing path', () => {
    expect(() =>
      validateProviderCatalog({
        ...base,
        modelsFetch: {
          url: 'https://openrouter.ai/api/v1/models',
          auth: [{ header: 'authorization' }],
          listPath: 'data',
          idPath: 'id',
          entryFilters: { arrayIncludes: [{ value: 'tools' }] },
        },
      }),
    ).toThrow(/arrayIncludes/);
  });

  it('throws on an entryFilters.arrayIncludes entry missing value', () => {
    expect(() =>
      validateProviderCatalog({
        ...base,
        modelsFetch: {
          url: 'https://openrouter.ai/api/v1/models',
          auth: [{ header: 'authorization' }],
          listPath: 'data',
          idPath: 'id',
          entryFilters: { arrayIncludes: [{ path: 'supported_parameters' }] },
        },
      }),
    ).toThrow(/arrayIncludes/);
  });

  it('throws when excludeIdSubstrings has a non-string or empty entry', () => {
    expect(() =>
      validateProviderCatalog({
        ...base,
        modelsFetch: {
          url: 'https://openrouter.ai/api/v1/models',
          auth: [{ header: 'authorization' }],
          listPath: 'data',
          idPath: 'id',
          entryFilters: { excludeIdSubstrings: [42] },
        },
      }),
    ).toThrow(/excludeIdSubstrings/);
    expect(() =>
      validateProviderCatalog({
        ...base,
        modelsFetch: {
          url: 'https://openrouter.ai/api/v1/models',
          auth: [{ header: 'authorization' }],
          listPath: 'data',
          idPath: 'id',
          entryFilters: { excludeIdSubstrings: [''] },
        },
      }),
    ).toThrow(/excludeIdSubstrings/);
  });
});
