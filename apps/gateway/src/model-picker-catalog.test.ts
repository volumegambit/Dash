import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverCatalogModels, validateProviderCatalog } from '@dash/plugins';
import type { GatewayCredentialStore } from './credential-store.js';
import { type ModelsRouteResponse, createModelsRoute } from './models-route.js';
import { ModelsStore } from './models-store.js';
import { createPluginModelCatalog } from './plugin-providers.js';

async function loadCatalog(id: string) {
  return validateProviderCatalog(
    JSON.parse(
      await readFile(
        new URL(`../plugins/dash-core-providers/providers/${id}.json`, import.meta.url),
        'utf8',
      ),
    ),
  );
}

describe('bundled catalogs served to the mobile model picker', () => {
  let dataDir: string;
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'model-picker-catalog-'));
  });
  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('serves current concrete fallback models without provider credentials', async () => {
    const catalogs = await Promise.all(['openai', 'moonshotai'].map(loadCatalog));
    const configs = catalogs.map((catalog) => ({ pluginName: 'dash-core-providers', catalog }));
    const app = createModelsRoute({
      store: new ModelsStore(dataDir),
      credentialStore: {
        readProviderApiKeys: async () => ({}),
      } as unknown as GatewayCredentialStore,
      getProviderConfigs: () => configs,
      strictReadOnly: true,
    });
    const response = await app.request('/');
    expect(response.status).toBe(200);
    const body = (await response.json()) as ModelsRouteResponse;
    expect(body.source).toBe('bootstrap');
    const expected = [
      'openai/gpt-6-astra',
      'openai/gpt-5.6-sol',
      'openai/gpt-5.6-terra',
      'openai/gpt-5.6-luna',
      'moonshotai/kimi-k3',
    ];
    expect(body.models.map((model: { value: string }) => model.value)).toEqual(
      expect.arrayContaining(expected),
    );
    const runtime = createPluginModelCatalog(configs);
    for (const value of expected) {
      const [provider, id] = value.split('/');
      expect(runtime.resolve(provider, id)).toMatchObject({
        id,
        provider,
        reasoning: true,
        input: ['text', 'image'],
      });
    }
  });

  it('discovers current OpenRouter models after invalidating an older cached list', async () => {
    const catalogs = await Promise.all(['openai', 'moonshotai', 'openrouter'].map(loadCatalog));
    const ids = [
      'openai/gpt-6-astra',
      'openai/gpt-6-astra-pro',
      'openai/gpt-5.6-sol',
      'openai/gpt-5.6-sol-pro',
      'openai/gpt-5.6-terra',
      'openai/gpt-5.6-terra-pro',
      'openai/gpt-5.6-luna',
      'openai/gpt-5.6-luna-pro',
      'moonshotai/kimi-k3',
    ];
    const store = new ModelsStore(dataDir);
    await store.save(
      [{ value: 'openrouter/openai/gpt-5.5', label: 'GPT-5.5', provider: 'openrouter' }],
      '2026-09-07',
    );
    const fetchModels = vi.fn(async () =>
      Response.json({
        data: [
          ...ids.map((id) => ({ id, name: id, supported_parameters: ['tools'] })),
          { id: 'openai/gpt-6-astra:batch', supported_parameters: ['tools'] },
          { id: 'openai/gpt-6-astra-no-tools', supported_parameters: [] },
        ],
      }),
    );
    const app = createModelsRoute({
      store,
      credentialStore: {
        readProviderApiKeys: async () => ({ openrouter: 'test-key' }),
      } as unknown as GatewayCredentialStore,
      getProviderConfigs: () =>
        catalogs.map((catalog) => ({ pluginName: 'dash-core-providers', catalog })),
      discover: (catalogs, credentials) =>
        discoverCatalogModels(catalogs, credentials, fetchModels),
      strictReadOnly: true,
    });
    const response = await app.request('/');
    expect(response.status).toBe(200);
    const body = (await response.json()) as ModelsRouteResponse;
    const values = body.models.map((model: { value: string }) => model.value);
    expect(fetchModels).toHaveBeenCalledOnce();
    expect(values).toEqual(expect.arrayContaining(ids.map((id) => `openrouter/${id}`)));
    expect(values).not.toContain('openrouter/openai/gpt-6-astra:batch');
    expect(values).not.toContain('openrouter/openai/gpt-6-astra-no-tools');
    // The real discover/filter path must return the models too; static fallback entries alone
    // would otherwise conceal a stale OpenRouter allow-list in the response above.
    const persisted = await store.load(body.supportedModelsReviewedAt);
    expect(persisted?.models.map((model) => model.value)).toEqual(
      expect.arrayContaining(ids.map((id) => `openrouter/${id}`)),
    );
    const runtime = createPluginModelCatalog(
      catalogs.map((catalog) => ({ pluginName: 'dash-core-providers', catalog })),
    );
    for (const id of ids) {
      expect(runtime.resolve('openrouter', id)).toMatchObject({ input: ['text', 'image'] });
    }
  });
});
