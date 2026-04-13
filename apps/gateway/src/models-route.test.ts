import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GatewayCredentialStore } from './credential-store.js';
import { createModelsRoute } from './models-route.js';
import { ModelsStore } from './models-store.js';

function makeCredentialStore(keys: Record<string, string> = {}): GatewayCredentialStore {
  return {
    readProviderApiKeys: vi.fn().mockResolvedValue(keys),
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
    init: vi.fn(),
  } as unknown as GatewayCredentialStore;
}

describe('createModelsRoute', () => {
  let dataDir: string;
  let store: ModelsStore;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'models-route-'));
    store = new ModelsStore(dataDir);
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('GET /models returns BOOTSTRAP_MODELS with source=bootstrap when no credentials', async () => {
    const discover = vi.fn().mockResolvedValue({ models: [], errors: {}, providersConfigured: 0 });
    const app = createModelsRoute({
      store,
      credentialStore: makeCredentialStore({}),
      discover,
    });

    const res = await app.request('/');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { models: unknown[]; source: string };
    expect(body.source).toBe('bootstrap');
    expect(body.models.length).toBeGreaterThan(0);
    // Did not persist
    expect(await store.load()).toBeNull();
  });

  it('GET /models calls discover when store is empty and credentials exist', async () => {
    const discover = vi.fn().mockResolvedValue({
      models: [
        { value: 'anthropic/claude-opus-4-5', label: 'Claude Opus 4.5', provider: 'anthropic' },
      ],
      errors: {},
      providersConfigured: 1,
    });
    const app = createModelsRoute({
      store,
      credentialStore: makeCredentialStore({ anthropic: 'sk-ant' }),
      discover,
    });

    const res = await app.request('/');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { models: unknown[]; source: string };
    expect(body.source).toBe('live');
    expect(body.models).toHaveLength(1);
    expect(discover).toHaveBeenCalledOnce();
    // Persisted to store
    expect((await store.load())?.models).toHaveLength(1);
  });

  it('GET /models returns from store on hit (no discover call)', async () => {
    await store.save([
      { value: 'anthropic/claude-opus-4-5', label: 'Claude Opus 4.5', provider: 'anthropic' },
    ]);
    const discover = vi.fn();
    const app = createModelsRoute({
      store,
      credentialStore: makeCredentialStore({ anthropic: 'sk-ant' }),
      discover,
    });

    const res = await app.request('/');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { models: unknown[]; source: string };
    expect(body.source).toBe('live');
    expect(body.models).toHaveLength(1);
    expect(discover).not.toHaveBeenCalled();
  });

  it('POST /models/refresh always triggers discover', async () => {
    await store.save([
      { value: 'anthropic/claude-opus-4-5', label: 'Claude Opus 4.5', provider: 'anthropic' },
    ]);
    const discover = vi.fn().mockResolvedValue({
      models: [
        { value: 'anthropic/claude-opus-4-5', label: 'Claude Opus 4.5', provider: 'anthropic' },
        { value: 'anthropic/claude-sonnet-4-5', label: 'Claude Sonnet 4.5', provider: 'anthropic' },
      ],
      errors: {},
      providersConfigured: 1,
    });
    const app = createModelsRoute({
      store,
      credentialStore: makeCredentialStore({ anthropic: 'sk-ant' }),
      discover,
    });

    const res = await app.request('/refresh', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { models: unknown[] };
    expect(body.models).toHaveLength(2);
    expect(discover).toHaveBeenCalledOnce();
  });

  it('mutex: concurrent GET /models on empty store discover only once', async () => {
    let resolveDiscover!: (v: unknown) => void;
    const discoverPromise = new Promise((resolve) => {
      resolveDiscover = resolve;
    });
    const discover = vi.fn().mockReturnValue(discoverPromise);
    const app = createModelsRoute({
      store,
      credentialStore: makeCredentialStore({ anthropic: 'sk-ant' }),
      discover,
    });

    // Fire three parallel GETs before the discover resolves
    const [r1, r2, r3] = await Promise.all([
      (async () => {
        const promise = app.request('/');
        // Yield to let request enter the mutex
        await new Promise((r) => setTimeout(r, 10));
        resolveDiscover({
          models: [{ value: 'anthropic/claude-opus-4-5', label: 'X', provider: 'anthropic' }],
          errors: {},
          providersConfigured: 1,
        });
        return promise;
      })(),
      app.request('/'),
      app.request('/'),
    ]);

    expect(discover).toHaveBeenCalledTimes(1);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(200);
  });

  it('GET /models?debug=true returns bootstrap, patterns, and providers', async () => {
    const discover = vi.fn().mockResolvedValue({
      models: [],
      errors: {},
      providersConfigured: 0,
    });
    const app = createModelsRoute({
      store,
      credentialStore: makeCredentialStore({}),
      discover,
    });

    const res = await app.request('/?debug=true');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      bootstrap: unknown[];
      patterns: unknown[];
      providersConfigured: string[];
      providersAvailable: string[];
    };
    expect(body.bootstrap.length).toBeGreaterThan(0);
    expect(body.patterns.length).toBeGreaterThan(0);
    expect(body.providersConfigured).toEqual([]);
    expect(body.providersAvailable).toEqual(['anthropic', 'openai', 'google']);
  });

  it('passes through per-provider errors from discover', async () => {
    const discover = vi.fn().mockResolvedValue({
      models: [{ value: 'anthropic/claude-opus-4-5', label: 'X', provider: 'anthropic' }],
      errors: { openai: 'OpenAI /v1/models returned 401 Unauthorized' },
      providersConfigured: 2,
    });
    const app = createModelsRoute({
      store,
      credentialStore: makeCredentialStore({ anthropic: 'sk-ant', openai: 'sk-openai' }),
      discover,
    });

    const res = await app.request('/');
    const body = (await res.json()) as { errors: Record<string, string> };
    expect(body.errors.openai).toContain('401');
  });
});
