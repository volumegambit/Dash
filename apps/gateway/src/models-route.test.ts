import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProviderCatalog } from '@dash/plugin-sdk';
import type { ProviderConfigEntry } from '@dash/plugins';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GatewayCredentialStore } from './credential-store.js';
import { createModelsController, createModelsRoute } from './models-route.js';
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

/**
 * Minimal synthetic catalog. `sortOrder` drives dropdown order; `models` are the
 * static (bootstrap) list; `supportedPatterns` feed the debug `patterns` block;
 * `reviewedAt` feeds the store fingerprint.
 */
function makeCatalog(overrides: Partial<ProviderCatalog> & { id: string }): ProviderCatalog {
  return {
    id: overrides.id,
    name: overrides.name ?? overrides.id,
    api: 'openai-completions',
    baseUrl: `https://${overrides.id}.example/v1`,
    models: [],
    ...overrides,
  } as ProviderCatalog;
}

function makeConfigs(catalogs: ProviderCatalog[]): ProviderConfigEntry[] {
  return catalogs.map((catalog) => ({ pluginName: 'dash-core-providers', catalog }));
}

// A catalog with static models + reviewedAt + a fetch spec so discover treats it
// as configured, and a bare catalog with a couple of static models only.
const anthropicCatalog = makeCatalog({
  id: 'anthropic',
  name: 'Anthropic',
  reviewedAt: '2026-07-01',
  ui: { sortOrder: 0 },
  models: [{ id: 'claude-opus-4-5', name: 'Claude Opus 4.5' }],
  supportedPatterns: [{ pattern: 'claude-opus', tier: 1 }],
});

const myllmCatalog = makeCatalog({
  id: 'myllm',
  name: 'My LLM',
  ui: { sortOrder: 5 },
  models: [{ id: 'm1', name: 'M One' }],
});

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

  it('GET /models with no credentials serves source=bootstrap: the catalogs’ static models in sortOrder, not persisted', async () => {
    const discover = vi.fn().mockResolvedValue({ models: [], errors: {}, providersConfigured: 0 });
    const app = createModelsRoute({
      store,
      credentialStore: makeCredentialStore({}),
      getProviderConfigs: () => makeConfigs([myllmCatalog, anthropicCatalog]),
      discover,
    });

    const res = await app.request('/');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { models: { value: string }[]; source: string };
    expect(body.source).toBe('bootstrap');
    // Static models in sortOrder order (anthropic sortOrder 0 before myllm 5).
    expect(body.models.map((m) => m.value)).toEqual(['anthropic/claude-opus-4-5', 'myllm/m1']);
    // Did not persist.
    expect(await store.load('2026-07-01')).toBeNull();
  });

  it('GET /models live path persists and serves source=live with discover models FIRST, static appended deduped', async () => {
    const discover = vi.fn().mockResolvedValue({
      models: [
        {
          value: 'anthropic/claude-opus-4-5',
          label: 'Claude Opus 4.5 (live)',
          provider: 'anthropic',
        },
      ],
      errors: {},
      providersConfigured: 1,
    });
    const app = createModelsRoute({
      store,
      credentialStore: makeCredentialStore({ anthropic: 'sk-ant' }),
      getProviderConfigs: () => makeConfigs([anthropicCatalog, myllmCatalog]),
      discover,
    });

    const res = await app.request('/');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      models: { value: string; label: string }[];
      source: string;
    };
    expect(body.source).toBe('live');
    // Discover model first (live label preserved — not shadowed by static dedupe),
    // then the static myllm/m1 appended.
    expect(body.models.map((m) => m.value)).toEqual(['anthropic/claude-opus-4-5', 'myllm/m1']);
    expect(body.models[0].label).toBe('Claude Opus 4.5 (live)');
    // Persisted (only live models, not the render-time static merge).
    expect((await store.load('2026-07-01'))?.models.map((m) => m.value)).toEqual([
      'anthropic/claude-opus-4-5',
    ]);
  });

  it('second GET serves from the store without calling discover again', async () => {
    const discover = vi.fn().mockResolvedValue({
      models: [{ value: 'anthropic/claude-opus-4-5', label: 'X', provider: 'anthropic' }],
      errors: {},
      providersConfigured: 1,
    });
    const app = createModelsRoute({
      store,
      credentialStore: makeCredentialStore({ anthropic: 'sk-ant' }),
      getProviderConfigs: () => makeConfigs([anthropicCatalog, myllmCatalog]),
      discover,
    });

    await app.request('/');
    expect(discover).toHaveBeenCalledOnce();
    const res = await app.request('/');
    expect(res.status).toBe(200);
    // Still only one discover call — second GET served from the store.
    expect(discover).toHaveBeenCalledOnce();
  });

  it('bumping a catalog reviewedAt in the getter invalidates the store on the next GET', async () => {
    const discover = vi.fn().mockResolvedValue({
      models: [{ value: 'anthropic/claude-opus-4-5', label: 'X', provider: 'anthropic' }],
      errors: {},
      providersConfigured: 1,
    });
    let anthropic = anthropicCatalog;
    const app = createModelsRoute({
      store,
      credentialStore: makeCredentialStore({ anthropic: 'sk-ant' }),
      getProviderConfigs: () => makeConfigs([anthropic, myllmCatalog]),
      discover,
    });

    await app.request('/');
    expect(discover).toHaveBeenCalledOnce();

    // A catalog audit bumps reviewedAt → fingerprint moves → store invalidated.
    anthropic = makeCatalog({ ...anthropicCatalog, reviewedAt: '2026-07-02' });
    await app.request('/');
    expect(discover).toHaveBeenCalledTimes(2);
  });

  it('POST /models/refresh always triggers discover', async () => {
    await store.save(
      [{ value: 'anthropic/claude-opus-4-5', label: 'X', provider: 'anthropic' }],
      '2026-07-01',
    );
    const discover = vi.fn().mockResolvedValue({
      models: [
        { value: 'anthropic/claude-opus-4-5', label: 'X', provider: 'anthropic' },
        { value: 'anthropic/claude-sonnet-4-5', label: 'Claude Sonnet 4.5', provider: 'anthropic' },
      ],
      errors: {},
      providersConfigured: 1,
    });
    const app = createModelsRoute({
      store,
      credentialStore: makeCredentialStore({ anthropic: 'sk-ant' }),
      getProviderConfigs: () => makeConfigs([anthropicCatalog]),
      discover,
    });

    const res = await app.request('/refresh', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { models: unknown[] };
    expect(body.models).toHaveLength(2);
    expect(discover).toHaveBeenCalledOnce();
  });

  it('mutex: concurrent legacy and strict mobile GETs discover once and match', async () => {
    let resolveDiscover!: (v: unknown) => void;
    const discoverPromise = new Promise((resolve) => {
      resolveDiscover = resolve;
    });
    const discover = vi.fn().mockReturnValue(discoverPromise);
    const options = {
      store,
      credentialStore: makeCredentialStore({ anthropic: 'sk-ant' }),
      getProviderConfigs: () => makeConfigs([anthropicCatalog]),
      discover,
    };
    const controller = createModelsController(options);
    const legacy = createModelsRoute({ ...options, controller });
    const mobile = createModelsRoute({ ...options, controller, strictReadOnly: true });

    const [r1, r2, r3] = await Promise.all([
      (async () => {
        const promise = legacy.request('/');
        await new Promise((r) => setTimeout(r, 10));
        resolveDiscover({
          models: [{ value: 'anthropic/claude-opus-4-5', label: 'X', provider: 'anthropic' }],
          errors: {},
          providersConfigured: 1,
        });
        return promise;
      })(),
      mobile.request('/'),
      legacy.request('/'),
    ]);

    expect(discover).toHaveBeenCalledTimes(1);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(200);
    const legacyBody = await r1.json();
    expect(await r2.json()).toEqual(legacyBody);
    expect(await r3.json()).toEqual(legacyBody);
  });

  it('explicit refresh prevents a displaced discovery from overwriting the cache', async () => {
    let resolveStale!: (value: unknown) => void;
    let resolveFresh!: (value: unknown) => void;
    const staleDiscovery = new Promise((resolve) => {
      resolveStale = resolve;
    });
    const freshDiscovery = new Promise((resolve) => {
      resolveFresh = resolve;
    });
    const discover = vi
      .fn()
      .mockReturnValueOnce(staleDiscovery)
      .mockReturnValueOnce(freshDiscovery);
    const options = {
      store,
      credentialStore: makeCredentialStore({ anthropic: 'sk-ant' }),
      getProviderConfigs: () => makeConfigs([anthropicCatalog]),
      discover,
    };
    const controller = createModelsController(options);
    const legacy = createModelsRoute({ ...options, controller });
    const mobile = createModelsRoute({ ...options, controller, strictReadOnly: true });

    const staleRequest = mobile.request('/');
    await vi.waitFor(() => expect(discover).toHaveBeenCalledTimes(1));
    const refreshRequest = legacy.request('/refresh', { method: 'POST' });
    await vi.waitFor(() => expect(discover).toHaveBeenCalledTimes(2));
    const joinedMobileRequest = mobile.request('/');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(discover).toHaveBeenCalledTimes(2);

    resolveFresh({
      models: [{ value: 'anthropic/fresh', label: 'Fresh', provider: 'anthropic' }],
      errors: {},
      providersConfigured: 1,
    });
    const [refreshResponse, joinedMobileResponse] = await Promise.all([
      refreshRequest,
      joinedMobileRequest,
    ]);
    expect(await joinedMobileResponse.json()).toEqual(await refreshResponse.json());

    resolveStale({
      models: [{ value: 'anthropic/stale', label: 'Stale', provider: 'anthropic' }],
      errors: {},
      providersConfigured: 1,
    });
    expect((await staleRequest).status).toBe(200);
    expect((await store.load('2026-07-01'))?.models.map((model) => model.value)).toEqual([
      'anthropic/fresh',
    ]);
  });

  it('an older request finalizer cannot detach callers from a pending refresh', async () => {
    let resolveStale!: (value: unknown) => void;
    let resolveFresh!: (value: unknown) => void;
    const staleDiscovery = new Promise((resolve) => {
      resolveStale = resolve;
    });
    const freshDiscovery = new Promise((resolve) => {
      resolveFresh = resolve;
    });
    const discover = vi
      .fn()
      .mockReturnValueOnce(staleDiscovery)
      .mockReturnValueOnce(freshDiscovery);
    const options = {
      store,
      credentialStore: makeCredentialStore({ anthropic: 'sk-ant' }),
      getProviderConfigs: () => makeConfigs([anthropicCatalog]),
      discover,
    };
    const controller = createModelsController(options);
    const legacy = createModelsRoute({ ...options, controller });
    const mobile = createModelsRoute({ ...options, controller, strictReadOnly: true });

    const staleRequest = mobile.request('/');
    await vi.waitFor(() => expect(discover).toHaveBeenCalledTimes(1));
    const refreshRequest = legacy.request('/refresh', { method: 'POST' });
    await vi.waitFor(() => expect(discover).toHaveBeenCalledTimes(2));

    resolveStale({
      models: [{ value: 'anthropic/stale', label: 'Stale', provider: 'anthropic' }],
      errors: {},
      providersConfigured: 1,
    });
    expect((await staleRequest).status).toBe(200);

    const joinedMobileRequest = mobile.request('/');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(discover).toHaveBeenCalledTimes(2);

    resolveFresh({
      models: [{ value: 'anthropic/fresh', label: 'Fresh', provider: 'anthropic' }],
      errors: {},
      providersConfigured: 1,
    });
    const [refreshResponse, joinedMobileResponse] = await Promise.all([
      refreshRequest,
      joinedMobileRequest,
    ]);
    expect(await joinedMobileResponse.json()).toEqual(await refreshResponse.json());
  });

  it('a zero-credential refresh clears a stale save that was already queued', async () => {
    let releaseSave!: () => void;
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    let cachedModels: string[] | null = null;
    let writeQueue = Promise.resolve();
    const enqueue = (write: () => Promise<void>): Promise<void> => {
      const run = writeQueue.then(write, write);
      writeQueue = run.then(
        () => {},
        () => {},
      );
      return run;
    };
    const queuedStore = {
      load: vi.fn().mockResolvedValue(null),
      save: vi.fn((models: Parameters<ModelsStore['save']>[0]) =>
        enqueue(async () => {
          await saveGate;
          cachedModels = models.map((model) => model.value);
        }),
      ),
      clear: vi.fn(() =>
        enqueue(async () => {
          cachedModels = null;
        }),
      ),
    } as unknown as ModelsStore;
    const discover = vi
      .fn()
      .mockResolvedValueOnce({
        models: [{ value: 'anthropic/stale', label: 'Stale', provider: 'anthropic' }],
        errors: {},
        providersConfigured: 1,
      })
      .mockResolvedValueOnce({ models: [], errors: {}, providersConfigured: 0 });
    const controller = createModelsController({
      store: queuedStore,
      credentialStore: makeCredentialStore({}),
      getProviderConfigs: () => makeConfigs([anthropicCatalog]),
      discover,
    });

    const staleRequest = controller.get();
    await vi.waitFor(() => expect(queuedStore.save).toHaveBeenCalledOnce());
    const refreshRequest = controller.refresh();
    await vi.waitFor(() => expect(discover).toHaveBeenCalledTimes(2));
    releaseSave();

    const [staleResponse, refreshResponse] = await Promise.all([staleRequest, refreshRequest]);
    expect(staleResponse.source).toBe('live');
    expect(refreshResponse.source).toBe('bootstrap');
    expect(queuedStore.clear).toHaveBeenCalledOnce();
    expect(cachedModels).toBeNull();
  });

  it('GET /models?debug=true carries catalog-derived bootstrap, patterns, and providers', async () => {
    const discover = vi.fn().mockResolvedValue({
      models: [],
      errors: {},
      providersConfigured: 0,
    });
    const app = createModelsRoute({
      store,
      credentialStore: makeCredentialStore({}),
      getProviderConfigs: () => makeConfigs([anthropicCatalog, myllmCatalog]),
      discover,
    });

    const res = await app.request('/?debug=true');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      bootstrap: { value: string }[];
      patterns: { provider: string; pattern: string; tier: number }[];
      providersConfigured: string[];
      providersAvailable: string[];
    };
    // bootstrap = sorted static expansion.
    expect(body.bootstrap.map((m) => m.value)).toEqual(['anthropic/claude-opus-4-5', 'myllm/m1']);
    // patterns = flatMap of catalogs' supportedPatterns.
    expect(body.patterns).toEqual([{ provider: 'anthropic', pattern: 'claude-opus', tier: 1 }]);
    expect(body.providersConfigured).toEqual([]);
    expect(body.providersAvailable).toEqual(['anthropic', 'myllm']);
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
      getProviderConfigs: () => makeConfigs([anthropicCatalog]),
      discover,
    });

    const res = await app.request('/');
    const body = (await res.json()) as { errors: Record<string, string> };
    expect(body.errors.openai).toContain('401');
  });

  it('render-time static merge never shadows a live core model and is never persisted', async () => {
    // A static catalog model whose value collides with a live discover model:
    // the live entry (and its label) wins; the store holds only the live model.
    const discover = vi.fn().mockResolvedValue({
      models: [{ value: 'anthropic/claude-opus-4-5', label: 'LIVE', provider: 'anthropic' }],
      errors: {},
      providersConfigured: 1,
    });
    const app = createModelsRoute({
      store,
      credentialStore: makeCredentialStore({ anthropic: 'sk-ant' }),
      getProviderConfigs: () => makeConfigs([anthropicCatalog, myllmCatalog]),
      discover,
    });

    const res = await app.request('/');
    const body = (await res.json()) as { models: { value: string; label: string }[] };
    expect(body.models.map((m) => m.value)).toEqual(['anthropic/claude-opus-4-5', 'myllm/m1']);
    expect(body.models[0].label).toBe('LIVE');
    expect((await store.load('2026-07-01'))?.models.map((m) => m.value)).toEqual([
      'anthropic/claude-opus-4-5',
    ]);
  });

  it('reads getProviderConfigs LIVE per request (a reload-added provider appears without rebuild)', async () => {
    const discover = vi.fn().mockResolvedValue({ models: [], errors: {}, providersConfigured: 0 });
    let configs: ProviderConfigEntry[] = makeConfigs([anthropicCatalog]);
    const app = createModelsRoute({
      store,
      credentialStore: makeCredentialStore({}),
      getProviderConfigs: () => configs,
      discover,
    });

    const before = await app.request('/');
    const beforeBody = (await before.json()) as { models: { value: string }[] };
    expect(beforeBody.models.map((m) => m.value)).not.toContain('myllm/m1');

    // Reload adds a provider.
    configs = makeConfigs([anthropicCatalog, myllmCatalog]);

    const after = await app.request('/');
    const afterBody = (await after.json()) as { models: { value: string }[] };
    expect(afterBody.models.map((m) => m.value)).toContain('myllm/m1');
  });
});
