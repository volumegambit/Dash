import type { ProviderCatalog } from '@dash/plugin-sdk';
import {
  catalogSortKey,
  discoverCatalogModels,
  newestCatalogReviewedAt,
} from './catalog-discover.js';
import { CatalogFetchError } from './catalog-fetch.js';

/** Stub fetch returning a canned JSON body per matched URL substring. */
function routedFetch(routes: Record<string, unknown>) {
  const impl = (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    for (const [needle, body] of Object.entries(routes)) {
      if (url.includes(needle)) {
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return impl;
}

/** Fetch that always throws a CatalogFetchError for a given provider substring. */
function throwingFetch(routes: Record<string, unknown>, throwOn: string, provider: string) {
  const impl = (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    if (url.includes(throwOn)) {
      throw new CatalogFetchError(provider, 500, `${provider} boom`);
    }
    for (const [needle, body] of Object.entries(routes)) {
      if (url.includes(needle)) {
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return impl;
}

const ANTHROPIC: ProviderCatalog = {
  id: 'anthropic',
  label: 'Anthropic',
  credentialPrefix: 'anthropic-api-key',
  baseUrl: 'https://api.anthropic.com',
  api: 'anthropic-messages',
  models: [],
  modelsFetch: {
    url: 'https://api.anthropic.com/v1/models',
    auth: [{ header: 'x-api-key' }],
    listPath: 'data',
    idPath: 'id',
    namePath: 'display_name',
  },
  supportedPatterns: [
    { pattern: 'claude-opus-*', tier: 0 },
    { pattern: 'claude-sonnet-*', tier: 1 },
  ],
  reviewedAt: '2026-06-21',
  ui: { sortOrder: 0 },
};

const GOOGLE: ProviderCatalog = {
  id: 'google',
  label: 'Google',
  credentialPrefix: 'google-api-key',
  baseUrl: 'https://generativelanguage.googleapis.com',
  api: 'google-generative-ai',
  models: [],
  modelsFetch: {
    url: 'https://generativelanguage.googleapis.com/v1beta/models',
    auth: [{ queryParam: 'key' }],
    listPath: 'models',
    idPath: 'name',
    namePath: 'displayName',
    stripIdPrefix: 'models/',
  },
  supportedPatterns: [{ pattern: 'gemini-*-flash*', tier: 1 }],
  excludedPatterns: ['gemini-*-tts*'],
  reviewedAt: '2026-07-01',
  ui: { sortOrder: 1 },
};

/** Static-only catalog: has a credential path but no supportedPatterns. */
const STATIC_ONLY: ProviderCatalog = {
  id: 'ollama',
  label: 'Ollama',
  credentialPrefix: 'ollama-api-key',
  baseUrl: 'http://localhost:11434',
  api: 'openai-completions',
  models: [],
  modelsFetch: {
    url: 'http://localhost:11434/v1/models',
    auth: [{ header: 'authorization', valuePrefix: 'Bearer ' }],
    listPath: 'data',
    idPath: 'id',
  },
};

describe('catalogSortKey', () => {
  it('returns [ui.sortOrder ?? MAX, id]', () => {
    expect(catalogSortKey(ANTHROPIC)).toEqual([0, 'anthropic']);
    expect(catalogSortKey(GOOGLE)).toEqual([1, 'google']);
    expect(catalogSortKey(STATIC_ONLY)).toEqual([Number.MAX_SAFE_INTEGER, 'ollama']);
  });
});

describe('newestCatalogReviewedAt', () => {
  it('returns the max ISO date', () => {
    expect(
      newestCatalogReviewedAt([{ reviewedAt: '2026-06-21' }, { reviewedAt: '2026-07-01' }]),
    ).toBe('2026-07-01');
  });

  it("returns 'unreviewed' for empty or all-absent", () => {
    expect(newestCatalogReviewedAt([])).toBe('unreviewed');
    expect(newestCatalogReviewedAt([{}, {}])).toBe('unreviewed');
  });
});

describe('discoverCatalogModels', () => {
  it('fetches every credentialed, pattern-bearing catalog in parallel; orders by sortOrder then tier then id', async () => {
    const impl = routedFetch({
      'api.anthropic.com': {
        data: [
          { id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6' },
          { id: 'claude-opus-4-8', display_name: 'Claude Opus 4.8' },
        ],
      },
      'generativelanguage.googleapis.com': {
        models: [{ name: 'models/gemini-3.5-flash', displayName: 'Gemini 3.5 Flash' }],
      },
    });
    const result = await discoverCatalogModels([GOOGLE, ANTHROPIC], async () => 'key', impl);
    expect(result.providersConfigured).toBe(2);
    expect(result.errors).toEqual({});
    // anthropic (sortOrder 0) first, opus (tier 0) before sonnet (tier 1),
    // then google (sortOrder 1).
    expect(result.models).toEqual([
      { value: 'anthropic/claude-opus-4-8', label: 'Claude Opus 4.8', provider: 'anthropic' },
      { value: 'anthropic/claude-sonnet-4-6', label: 'Claude Sonnet 4.6', provider: 'anthropic' },
      { value: 'google/gemini-3.5-flash', label: 'Gemini 3.5 Flash', provider: 'google' },
    ]);
  });

  it('does not fetch or count a catalog whose credential is null', async () => {
    const impl = routedFetch({
      'api.anthropic.com': { data: [{ id: 'claude-opus-4-8', display_name: 'Opus' }] },
    });
    const result = await discoverCatalogModels(
      [ANTHROPIC, GOOGLE],
      async (id) => (id === 'anthropic' ? 'key' : null),
      impl,
    );
    expect(result.providersConfigured).toBe(1);
    expect(result.models.map((m) => m.provider)).toEqual(['anthropic']);
  });

  it('never fetches a catalog without supportedPatterns even with a credential', async () => {
    let ollamaCalled = false;
    const impl = (async (input: Parameters<typeof fetch>[0]) => {
      if (String(input).includes('11434')) ollamaCalled = true;
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const result = await discoverCatalogModels([STATIC_ONLY], async () => 'key', impl);
    expect(ollamaCalled).toBe(false);
    expect(result.providersConfigured).toBe(0);
    expect(result.models).toEqual([]);
  });

  it('records a per-catalog fetch failure in errors while other catalogs still return', async () => {
    const impl = throwingFetch(
      {
        'generativelanguage.googleapis.com': {
          models: [{ name: 'models/gemini-3.5-flash', displayName: 'Gemini 3.5 Flash' }],
        },
      },
      'api.anthropic.com',
      'anthropic',
    );
    const result = await discoverCatalogModels([ANTHROPIC, GOOGLE], async () => 'key', impl);
    expect(result.errors.anthropic).toBe('anthropic boom');
    expect(result.models).toEqual([
      { value: 'google/gemini-3.5-flash', label: 'Gemini 3.5 Flash', provider: 'google' },
    ]);
    // both still count as configured (credential resolved for both)
    expect(result.providersConfigured).toBe(2);
  });

  it('orders two same-tier models within a catalog by id.localeCompare', async () => {
    // A single pattern (tier 0) matches both ids; the fetch returns them in
    // reverse-alphabetical order, so a stable output proves the id.localeCompare
    // tie-break (not fetch order) drives within-catalog ordering at equal tier.
    const SAME_TIER: ProviderCatalog = {
      id: 'anthropic',
      label: 'Anthropic',
      credentialPrefix: 'anthropic-api-key',
      baseUrl: 'https://api.anthropic.com',
      api: 'anthropic-messages',
      models: [],
      modelsFetch: {
        url: 'https://api.anthropic.com/v1/models',
        auth: [{ header: 'x-api-key' }],
        listPath: 'data',
        idPath: 'id',
        namePath: 'display_name',
      },
      supportedPatterns: [{ pattern: 'claude-opus-*', tier: 0 }],
      ui: { sortOrder: 0 },
    };
    const impl = routedFetch({
      'api.anthropic.com': {
        data: [
          { id: 'claude-opus-4-9', display_name: 'Claude Opus 4.9' },
          { id: 'claude-opus-4-8', display_name: 'Claude Opus 4.8' },
        ],
      },
    });
    const result = await discoverCatalogModels([SAME_TIER], async () => 'key', impl);
    // Equal tier ⇒ id.localeCompare: 4-8 sorts before 4-9 despite fetch order.
    expect(result.models).toEqual([
      { value: 'anthropic/claude-opus-4-8', label: 'Claude Opus 4.8', provider: 'anthropic' },
      { value: 'anthropic/claude-opus-4-9', label: 'Claude Opus 4.9', provider: 'anthropic' },
    ]);
  });

  it('drops a fetched id matching an excluded pattern', async () => {
    const impl = routedFetch({
      'generativelanguage.googleapis.com': {
        models: [
          { name: 'models/gemini-3.5-flash', displayName: 'Gemini 3.5 Flash' },
          { name: 'models/gemini-2.5-flash-tts', displayName: 'Gemini Flash TTS' },
        ],
      },
    });
    const result = await discoverCatalogModels([GOOGLE], async () => 'key', impl);
    expect(result.models).toEqual([
      { value: 'google/gemini-3.5-flash', label: 'Gemini 3.5 Flash', provider: 'google' },
    ]);
  });
});
