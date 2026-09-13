import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ModelsFetchSpec } from '@dash/plugin-sdk';
import { RESERVED_PROVIDER_IDS, findCatalogPattern, validateProviderCatalog } from '@dash/plugins';
import { clampThinkingLevel, getModel, getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import { buildModel } from './plugin-providers.js';

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
      'gemini-*transcribe*',
      'gemini-*native-audio*',
      'gemini-*-live-*',
      'imagen-*',
      'veo-*',
      'lyria-*',
      'nano-banana-*',
      'deep-research-*',
      'antigravity-*',
      'aqa',
    ]);
  });

  it('anthropic auth rules all send the required anthropic-version header', async () => {
    // Anthropic's /v1/models rejects requests without anthropic-version (400),
    // which silently breaks live model discovery for the whole provider.
    const cat = validateProviderCatalog(await readCatalog('anthropic'));
    const spec = cat.modelsFetch as ModelsFetchSpec;
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

  it('moonshotai ranks kimi-k3 above every k2 generation', async () => {
    // K3 shipped with no matching glob, so it was invisible to every user until
    // `kimi-k3*` was added. Pin the ordering so a future k2 edit can't outrank it.
    const cat = validateProviderCatalog(await readCatalog('moonshotai'));
    const k3 = findCatalogPattern(cat, 'kimi-k3');
    expect(k3?.pattern).toBe('kimi-k3*');
    const k2Tiers = (cat.supportedPatterns ?? [])
      .filter((p) => p.pattern.startsWith('kimi-k2'))
      .map((p) => p.tier);
    expect(k2Tiers.length).toBeGreaterThan(0);
    expect(Math.min(...k2Tiers)).toBeGreaterThan(k3?.tier ?? Number.POSITIVE_INFINITY);
  });

  it('openai denies the non-chat modality families via excludedPatterns', async () => {
    const cat = validateProviderCatalog(await readCatalog('openai'));
    expect(cat.excludedPatterns).toEqual([
      'text-embedding-*',
      'omni-moderation-*',
      'whisper-*',
      'tts-1*',
      '*-tts*',
      '*-transcribe*',
      'gpt-audio*',
      'gpt-realtime*',
      'gpt-image-*',
      'chatgpt-image-*',
      'sora-*',
      '*-deep-research*',
      '*-search-preview*',
      'gpt-5-search-api*',
      'davinci*',
      'babbage-*',
    ]);
  });

  it('openai lists gpt-5.6* after the codex glob so codex ids keep their tier', async () => {
    // findCatalogPattern returns the FIRST matching allow pattern, so a
    // `gpt-5.6*` entry placed above `gpt-*-codex*` would swallow a future
    // gpt-5.6-codex and demote it to the generic 5.6 tier.
    const cat = validateProviderCatalog(await readCatalog('openai'));
    const patterns = (cat.supportedPatterns ?? []).map((p) => p.pattern);
    expect(patterns).toContain('gpt-5.6*');
    expect(patterns.indexOf('gpt-*-codex*')).toBeLessThan(patterns.indexOf('gpt-5.6*'));
    expect(findCatalogPattern(cat, 'gpt-5.6-codex')?.pattern).toBe('gpt-*-codex*');
    expect(findCatalogPattern(cat, 'gpt-5.6-sol')?.pattern).toBe('gpt-5.6*');
  });

  it('every bundled reasoning model resolves to a thinking level the provider accepts', async () => {
    // A reasoning model whose `thinkingLevelMap` marks `off` unavailable
    // (`null`) must clamp to a real level; a model that allows `off` must
    // either tolerate a missing `reasoning_effort` (no `off` key at all) or
    // declare the literal to send (`off: "none"`). The failure this guards is
    // a request with reasoning silently omitted, which such providers reject.
    const files = (await readdir(DIR)).filter((f) => f.endsWith('.json')).sort();
    for (const f of files) {
      const cat = validateProviderCatalog(JSON.parse(await readFile(join(DIR, f), 'utf-8')));
      for (const model of cat.models) {
        const built = buildModel(cat, model);
        const levels = getSupportedThinkingLevels(built);
        expect(levels.length, `${f}: "${model.id}" supports no thinking level`).toBeGreaterThan(0);

        const resolved = clampThinkingLevel(built, 'off');
        expect(levels, `${f}: "${model.id}" clamped to an unsupported level`).toContain(resolved);

        if (model.thinkingLevelMap?.off === null) {
          expect(resolved, `${f}: "${model.id}" requires reasoning but resolved to off`).not.toBe(
            'off',
          );
        }
      }
    }
  });

  it('bundled thinkingLevelMaps agree with pi-ai for models pi-ai also knows', async () => {
    // pi-ai's baked registry is the reference for reasoning requirements. Where
    // both describe the same provider/model, a divergent `off` handling means
    // one of them is wrong — and ours is the one that reaches the provider.
    const files = (await readdir(DIR)).filter((f) => f.endsWith('.json')).sort();
    const compared: string[] = [];
    for (const f of files) {
      const cat = validateProviderCatalog(JSON.parse(await readFile(join(DIR, f), 'utf-8')));
      for (const model of cat.models) {
        // biome-ignore lint/suspicious/noExplicitAny: provider/model ids are not statically known
        const known = getModel(cat.id as any, model.id as any);
        if (!known) continue;
        compared.push(`${cat.id}/${model.id}`);
        expect(
          getSupportedThinkingLevels(buildModel(cat, model)),
          `${f}: "${model.id}" thinking levels diverge from pi-ai`,
        ).toEqual(getSupportedThinkingLevels(known));
      }
    }
    // Guard the guard: if this drops to zero the assertion above is vacuous.
    expect(compared.length).toBeGreaterThan(0);
  });

  it('no catalog deny glob shadows its own static bootstrap models', async () => {
    // excludedPatterns short-circuits before the allow list, so an over-broad
    // deny silently removes a bootstrap model for users with zero credentials.
    const files = (await readdir(DIR)).filter((f) => f.endsWith('.json')).sort();
    for (const f of files) {
      const cat = validateProviderCatalog(JSON.parse(await readFile(join(DIR, f), 'utf-8')));
      for (const model of cat.models) {
        expect(
          findCatalogPattern(cat, model.id),
          `${f}: static "${model.id}" resolves to no pattern`,
        ).not.toBeNull();
      }
    }
  });
});
