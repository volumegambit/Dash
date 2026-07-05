import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ModelsFetchSpec } from '@dash/plugin-sdk';
import { RESERVED_PROVIDER_IDS, validateProviderCatalog } from '@dash/plugins';

const DIR = fileURLToPath(new URL('../plugins/dash-core-providers/providers', import.meta.url));

async function readCatalog(id: string): Promise<unknown> {
  return JSON.parse(await readFile(join(DIR, `${id}.json`), 'utf8'));
}

describe('bundled dash-core-providers catalogs (checked-in JSON invariants)', () => {
  it('ships exactly the five reserved catalogs, each valid', async () => {
    const files = (await readdir(DIR)).filter((f) => f.endsWith('.json')).sort();
    expect(files).toEqual([...RESERVED_PROVIDER_IDS].sort().map((id) => `${id}.json`));
    for (const f of files) {
      const catalog = validateProviderCatalog(JSON.parse(await readFile(join(DIR, f), 'utf-8')));
      expect(catalog.id).toBe(f.replace('.json', ''));
      expect(catalog.reviewedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(catalog.supportedPatterns?.length).toBeGreaterThan(0);
      expect(catalog.models.length).toBeGreaterThan(0);
      expect(typeof catalog.ui?.sortOrder).toBe('number');
      expect(catalog.ui?.description?.length).toBeGreaterThan(0);
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

  it('google carries the EXCLUDED_MODELS globs as excludedPatterns', async () => {
    const cat = validateProviderCatalog(await readCatalog('google'));
    expect(cat.excludedPatterns).toEqual([
      'gemini-embedding-*',
      'gemini-*-image*',
      'gemini-*-tts*',
      'gemini-robotics-*',
      'gemini-*-computer-use*',
    ]);
  });

  it('anthropic modelsFetch auth rules all carry the anthropic-version header', async () => {
    // api.anthropic.com/v1/models 400s without `anthropic-version` — every auth
    // rule (x-api-key and the sk-ant-oat OAuth rule) must send it via
    // extraHeaders, so live discovery works regardless of key shape.
    const cat = validateProviderCatalog(await readCatalog('anthropic'));
    const spec = cat.modelsFetch as ModelsFetchSpec;
    expect(spec.auth.length).toBeGreaterThan(0);
    for (const rule of spec.auth) {
      expect(rule.extraHeaders?.['anthropic-version']).toBe('2023-06-01');
    }
  });

  it('openrouter is dynamic with tools + no-colon entry filters', async () => {
    const cat = validateProviderCatalog(await readCatalog('openrouter'));
    expect(cat.dynamicModels).toBe(true);
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
});
