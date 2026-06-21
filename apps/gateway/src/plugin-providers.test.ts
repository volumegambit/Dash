import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProviderConfigEntry } from '@dash/plugins';
import { loadPlugins } from '@dash/plugins';
import type { Api, Model } from '@earendil-works/pi-ai';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendPluginModels,
  createPluginModelCatalog,
  expandPluginModelsForRoute,
} from './plugin-providers.js';

function entry(catalog: ProviderConfigEntry['catalog']): ProviderConfigEntry {
  return { pluginName: 'demo', catalog };
}

describe('createPluginModelCatalog', () => {
  it('resolves a static model into a pi-ai Model with defaults filled in', () => {
    const catalog = createPluginModelCatalog([
      entry({
        id: 'myllm',
        label: 'My LLM',
        credentialPrefix: 'myllm-api-key',
        baseUrl: 'https://x/v1',
        api: 'openai-completions',
        models: [{ id: 'm1', name: 'M One', contextWindow: 128000, maxTokens: 8192 }],
      }),
    ]);

    const model = catalog.resolve('myllm', 'm1') as Model<Api> | null;
    expect(model).not.toBeNull();
    expect(model?.id).toBe('m1');
    expect(model?.name).toBe('M One');
    expect(model?.provider).toBe('myllm');
    expect(model?.api).toBe('openai-completions');
    expect(model?.baseUrl).toBe('https://x/v1');
    expect(model?.contextWindow).toBe(128000);
    expect(model?.maxTokens).toBe(8192);
    // Defaulted fields.
    expect(model?.reasoning).toBe(false);
    expect(model?.input).toEqual(['text']);
    expect(model?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it('falls back name to id when name is absent', () => {
    const catalog = createPluginModelCatalog([
      entry({
        id: 'myllm',
        label: 'My LLM',
        credentialPrefix: 'myllm-api-key',
        baseUrl: 'https://x/v1',
        api: 'openai-completions',
        models: [{ id: 'm1', contextWindow: 1000, maxTokens: 100 }],
      }),
    ]);
    const model = catalog.resolve('myllm', 'm1') as Model<Api> | null;
    expect(model?.name).toBe('m1');
  });

  it('returns null for an unknown model id on a known provider', () => {
    const catalog = createPluginModelCatalog([
      entry({
        id: 'myllm',
        label: 'My LLM',
        credentialPrefix: 'myllm-api-key',
        baseUrl: 'https://x/v1',
        api: 'openai-completions',
        models: [{ id: 'm1', contextWindow: 1000, maxTokens: 100 }],
      }),
    ]);
    expect(catalog.resolve('myllm', 'unknown')).toBeNull();
  });

  it('returns null for an unknown provider', () => {
    const catalog = createPluginModelCatalog([
      entry({
        id: 'myllm',
        label: 'My LLM',
        credentialPrefix: 'myllm-api-key',
        baseUrl: 'https://x/v1',
        api: 'openai-completions',
        models: [{ id: 'm1', contextWindow: 1000, maxTokens: 100 }],
      }),
    ]);
    expect(catalog.resolve('other', 'm1')).toBeNull();
  });

  it('synthesizes a dynamic model from dynamicModelDefaults', () => {
    const catalog = createPluginModelCatalog([
      entry({
        id: 'myllm',
        label: 'My LLM',
        credentialPrefix: 'myllm-api-key',
        baseUrl: 'https://x/v1',
        api: 'openai-completions',
        models: [],
        dynamicModels: true,
        dynamicModelDefaults: { contextWindow: 8000, maxTokens: 2000 },
      }),
    ]);
    const model = catalog.resolve('myllm', 'anything') as Model<Api> | null;
    expect(model).not.toBeNull();
    expect(model?.id).toBe('anything');
    expect(model?.contextWindow).toBe(8000);
    expect(model?.maxTokens).toBe(2000);
    expect(model?.provider).toBe('myllm');
  });

  it('returns null for dynamicModels with no defaults (cannot size the model)', () => {
    const catalog = createPluginModelCatalog([
      entry({
        id: 'myllm',
        label: 'My LLM',
        credentialPrefix: 'myllm-api-key',
        baseUrl: 'https://x/v1',
        api: 'openai-completions',
        models: [],
        dynamicModels: true,
      }),
    ]);
    expect(catalog.resolve('myllm', 'anything')).toBeNull();
  });
});

describe('expandPluginModelsForRoute', () => {
  it('flattens static catalog models to FilteredModel entries', () => {
    const out = expandPluginModelsForRoute([
      entry({
        id: 'myllm',
        label: 'My LLM',
        credentialPrefix: 'myllm-api-key',
        baseUrl: 'https://x/v1',
        api: 'openai-completions',
        models: [
          { id: 'm1', name: 'M One', contextWindow: 1000, maxTokens: 100 },
          { id: 'm2', contextWindow: 1000, maxTokens: 100 },
        ],
      }),
    ]);
    expect(out).toEqual([
      { value: 'myllm/m1', label: 'M One', provider: 'myllm' },
      { value: 'myllm/m2', label: 'm2', provider: 'myllm' },
    ]);
  });

  it('returns an empty array when there are no provider configs', () => {
    expect(expandPluginModelsForRoute([])).toEqual([]);
  });
});

describe('appendPluginModels', () => {
  const baseResp = {
    models: [{ value: 'anthropic/x', label: 'X', provider: 'anthropic' }],
    source: 'live' as const,
    errors: {},
    fetchedAt: '2026-01-01T00:00:00.000Z',
    supportedModelsReviewedAt: '2026-01-01',
  };

  it('appends plugin models after core models, core wins on duplicate value', () => {
    const merged = appendPluginModels(baseResp, [
      { value: 'myllm/m1', label: 'M One', provider: 'myllm' },
      { value: 'anthropic/x', label: 'SHADOW', provider: 'anthropic' },
    ]);
    expect(merged.models).toEqual([
      { value: 'anthropic/x', label: 'X', provider: 'anthropic' },
      { value: 'myllm/m1', label: 'M One', provider: 'myllm' },
    ]);
    // Other response fields are preserved.
    expect(merged.source).toBe('live');
    expect(merged.fetchedAt).toBe(baseResp.fetchedAt);
  });

  it('returns the response unchanged when plugin models are empty', () => {
    expect(appendPluginModels(baseResp, [])).toBe(baseResp);
  });

  it('returns the response unchanged when plugin models are undefined', () => {
    expect(appendPluginModels(baseResp, undefined)).toBe(baseResp);
  });
});

describe('loader → catalog assembly (trusted plugin providers/*.json)', () => {
  let dataDir: string;
  let pluginsDir: string;
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'gw-providers-'));
    pluginsDir = join(dataDir, 'plugins');
    await mkdir(pluginsDir, { recursive: true });
  });
  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('builds a resolving catalog from a trusted plugin providers/*.json', async () => {
    const dir = join(pluginsDir, 'prov');
    await mkdir(join(dir, '.claude-plugin'), { recursive: true });
    await writeFile(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'prov' }));
    await mkdir(join(dir, 'providers'), { recursive: true });
    await writeFile(
      join(dir, 'providers', 'p.json'),
      JSON.stringify({
        id: 'acme',
        label: 'Acme',
        credentialPrefix: 'acme-api-key',
        baseUrl: 'https://acme.example/v1',
        api: 'openai-completions',
        models: [{ id: 'acme-fast', contextWindow: 64000, maxTokens: 4096 }],
      }),
    );

    const loaded = await loadPlugins({
      pluginsDir,
      entries: { prov: { enabled: true, trusted: true } },
    });
    expect(loaded.providerConfigs.length).toBe(1);

    const catalog = createPluginModelCatalog(loaded.providerConfigs);
    const model = catalog.resolve('acme', 'acme-fast') as Model<Api> | null;
    expect(model).not.toBeNull();
    expect(model?.id).toBe('acme-fast');
    expect(model?.provider).toBe('acme');
    expect(model?.baseUrl).toBe('https://acme.example/v1');
    expect(model?.api).toBe('openai-completions');
  });
});
