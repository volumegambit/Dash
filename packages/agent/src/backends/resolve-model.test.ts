import { resolveModelString } from './resolve-model.js';

const catalogModel = {
  id: 'claude-fable-5',
  name: 'Fable via catalog',
  api: 'anthropic-messages',
  provider: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  reasoning: true,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000_000,
  maxTokens: 64_000,
};

describe('resolveModelString', () => {
  it('throws on a bare model id without provider prefix', () => {
    expect(() => resolveModelString('claude-fable-5', undefined)).toThrow(/provider\/model/);
  });

  it('prefers the plugin catalog over pi-ai for ids the catalog declares', () => {
    const resolved = resolveModelString('anthropic/claude-fable-5', {
      resolve: (provider, modelId) =>
        provider === 'anthropic' && modelId === 'claude-fable-5' ? catalogModel : undefined,
    });
    expect(resolved.name).toBe('Fable via catalog');
  });

  it('falls back to pi-ai for ids the catalog does not know', () => {
    // pi-ai's static registry knows this model; the catalog declines it.
    const resolved = resolveModelString('anthropic/claude-opus-4-5', {
      resolve: () => undefined,
    });
    expect(resolved.provider).toBe('anthropic');
    expect(resolved.id).toBe('claude-opus-4-5');
  });

  it('falls back to pi-ai when no catalog is injected', () => {
    const resolved = resolveModelString('anthropic/claude-opus-4-5', undefined);
    expect(resolved.id).toBe('claude-opus-4-5');
  });

  it('throws a clear error when neither catalog nor pi-ai knows the model', () => {
    expect(() => resolveModelString('acme/unknown-1', { resolve: () => undefined })).toThrow(
      /Unknown model "acme\/unknown-1"/,
    );
  });
});
