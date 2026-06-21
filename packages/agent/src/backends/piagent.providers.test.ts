import type { Api, Model } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
import type { PluginModelCatalog } from '../types.js';
import { PiAgentBackend } from './piagent.js';

/**
 * Focused unit tests for the private `resolveModel` method's fallback to a
 * plugin-contributed model catalog. resolveModel is private, so we exercise it
 * directly via a cast — this avoids needing a live pi session.
 */

/** Build a minimal valid pi-ai Model<Api> for a fake catalog to return. */
function makeFakeModel(provider: string, id: string): Model<Api> {
  return {
    id,
    name: id,
    api: 'openai-completions',
    provider,
    baseUrl: 'https://example.test/v1',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 4096,
  };
}

/** Cast helper to call the private resolveModel directly. */
function resolve(backend: PiAgentBackend, modelStr: string): Model<Api> {
  return (backend as unknown as { resolveModel(s: string): Model<Api> }).resolveModel(modelStr);
}

function makeBackend(catalog?: PluginModelCatalog): PiAgentBackend {
  return new PiAgentBackend(
    { model: 'anthropic/claude-sonnet-4-5', systemPrompt: 'x' },
    {},
    undefined, // logger
    undefined, // sessionDir
    undefined, // managedSkillsDir
    undefined, // mcpManager
    undefined, // mcpConfigStore
    undefined, // mcpAgentContext
    undefined, // extraTools
    undefined, // extraSkillFiles
    undefined, // hookRunner
    catalog, // pluginModelCatalog
  );
}

describe('PiAgentBackend.resolveModel — plugin model catalog fallback', () => {
  it('returns the catalog model when the static registry does not know it', () => {
    const fake = makeFakeModel('myllm', 'm1');
    const catalog: PluginModelCatalog = {
      resolve: (provider, modelId) => (provider === 'myllm' && modelId === 'm1' ? fake : null),
    };
    const backend = makeBackend(catalog);
    expect(resolve(backend, 'myllm/m1')).toBe(fake);
  });

  it('prefers the static registry and does NOT consult the catalog for a known model', () => {
    const catalog: PluginModelCatalog = {
      resolve: () => {
        throw new Error('catalog.resolve must not be called when the registry has the model');
      },
    };
    const backend = makeBackend(catalog);
    // claude-sonnet-4-5 is a known-good registry model (see piagent.contract.test.ts).
    const model = resolve(backend, 'anthropic/claude-sonnet-4-5');
    expect(model).toBeDefined();
    expect(typeof model.id).toBe('string');
  });

  it('throws the Unknown model error when the catalog returns null', () => {
    const catalog: PluginModelCatalog = { resolve: () => null };
    const backend = makeBackend(catalog);
    expect(() => resolve(backend, 'myllm/nope')).toThrow(/Unknown model "myllm\/nope"/);
  });

  it('throws the Unknown model error when there is no catalog (regression: behavior intact)', () => {
    const backend = makeBackend(undefined);
    expect(() => resolve(backend, 'myllm/nope')).toThrow(/Unknown model "myllm\/nope"/);
  });

  it('throws the format error for input with no slash, regardless of catalog', () => {
    const catalog: PluginModelCatalog = {
      resolve: () => {
        throw new Error('catalog.resolve must not be called for a malformed model string');
      },
    };
    const backend = makeBackend(catalog);
    expect(() => resolve(backend, 'noslash')).toThrow(/must be in "provider\/model" format/);
  });
});
