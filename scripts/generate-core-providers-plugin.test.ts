import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODELS_REVIEWED_AT } from '@dash/models';
import type { ModelsFetchSpec } from '@dash/plugin-sdk';
import { validateProviderCatalog } from '@dash/plugins';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = resolve(__dirname, '../apps/gateway/plugins/dash-core-providers');
const PROVIDER_IDS = ['anthropic', 'openai', 'google', 'moonshotai', 'openrouter'] as const;

async function readCatalog(id: string): Promise<unknown> {
  const raw = await readFile(resolve(PLUGIN_DIR, 'providers', `${id}.json`), 'utf8');
  return JSON.parse(raw);
}

describe('generated dash-core-providers catalogs', () => {
  it('every catalog passes validateProviderCatalog with non-empty patterns + models', async () => {
    for (const id of PROVIDER_IDS) {
      const cat = validateProviderCatalog(await readCatalog(id));
      expect(cat.id).toBe(id === 'moonshotai' ? 'moonshotai' : id);
      expect(cat.credentialPrefix).toBe(`${id}-api-key`);
      expect(cat.models.length).toBeGreaterThan(0);
      expect(cat.supportedPatterns?.length ?? 0).toBeGreaterThan(0);
      expect(cat.reviewedAt).toBe(MODELS_REVIEWED_AT);
    }
  });

  it('openai has two modelsFetch variants with the JWT (whenKeyPrefix eyJ) first', async () => {
    const cat = validateProviderCatalog(await readCatalog('openai'));
    const variants = cat.modelsFetch as ModelsFetchSpec[];
    expect(Array.isArray(variants)).toBe(true);
    expect(variants).toHaveLength(2);
    expect(variants[0]?.whenKeyPrefix).toBe('eyJ');
    expect(variants[0]?.url).toContain('chatgpt.com/backend-api/codex/models');
    expect(variants[0]?.idPath).toBe('slug');
    expect(variants[1]?.whenKeyPrefix).toBeUndefined();
    expect(variants[1]?.url).toContain('api.openai.com/v1/models');
    expect(cat.api).toBe('openai-completions');
  });

  it('google uses query-param key auth + models/ prefix strip + generative-ai api', async () => {
    const cat = validateProviderCatalog(await readCatalog('google'));
    const spec = cat.modelsFetch as ModelsFetchSpec;
    expect(cat.api).toBe('google-generative-ai');
    expect(spec.auth[0]?.queryParam).toBe('key');
    expect(spec.stripIdPrefix).toBe('models/');
  });

  it('openrouter is dynamic with tools + no-colon entry filters', async () => {
    const cat = validateProviderCatalog(await readCatalog('openrouter'));
    expect(cat.dynamicModels).toBe(true);
    expect(cat.dynamicModelDefaults).toEqual({ contextWindow: 128000, maxTokens: 8192 });
    const spec = cat.modelsFetch as ModelsFetchSpec;
    expect(spec.entryFilters?.arrayIncludes).toEqual([
      { path: 'supported_parameters', value: 'tools' },
    ]);
    expect(spec.entryFilters?.excludeIdSubstrings).toEqual([':']);
  });

  it('moonshotai id is exactly "moonshotai"', async () => {
    const cat = validateProviderCatalog(await readCatalog('moonshotai'));
    expect(cat.id).toBe('moonshotai');
    expect(cat.baseUrl).toBe('https://api.moonshot.ai/v1');
  });

  it('anthropic encodes the OAuth header swap auth rules', async () => {
    const cat = validateProviderCatalog(await readCatalog('anthropic'));
    expect(cat.api).toBe('anthropic-messages');
    const spec = cat.modelsFetch as ModelsFetchSpec;
    expect(spec.auth[0]?.whenKeyPrefix).toBe('sk-ant-oat');
    expect(spec.auth[0]?.extraHeaders?.['anthropic-beta']).toBe('oauth-2025-04-20');
    expect(spec.auth[1]?.header).toBe('x-api-key');
  });

  it('the manifest names the plugin dash-core-providers', async () => {
    const raw = await readFile(resolve(PLUGIN_DIR, '.claude-plugin', 'plugin.json'), 'utf8');
    const manifest = JSON.parse(raw) as { name: string; version: string; description: string };
    expect(manifest.name).toBe('dash-core-providers');
    expect(manifest.version.length).toBeGreaterThan(0);
    expect(manifest.description).toContain('Anthropic');
  });
});
