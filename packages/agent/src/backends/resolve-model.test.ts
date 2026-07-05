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

  describe('allowedProviders gating', () => {
    it('resolves an allowed provider via the catalog path', () => {
      const resolved = resolveModelString(
        'anthropic/claude-fable-5',
        {
          resolve: (provider, modelId) =>
            provider === 'anthropic' && modelId === 'claude-fable-5' ? catalogModel : undefined,
        },
        ['anthropic'],
      );
      expect(resolved.name).toBe('Fable via catalog');
    });

    it('resolves an allowed provider via the pi-ai path', () => {
      const resolved = resolveModelString('anthropic/claude-opus-4-5', undefined, ['anthropic']);
      expect(resolved.id).toBe('claude-opus-4-5');
    });

    it('throws the policy message for a disallowed provider even when the catalog knows the model', () => {
      expect(() =>
        resolveModelString(
          'anthropic/claude-fable-5',
          {
            resolve: (provider, modelId) =>
              provider === 'anthropic' && modelId === 'claude-fable-5' ? catalogModel : undefined,
          },
          ['openai'],
        ),
      ).toThrow('Provider "anthropic" is not allowed for this agent (allowed: openai)');
    });

    it('lists all allowed providers in the policy message', () => {
      expect(() =>
        resolveModelString('anthropic/claude-opus-4-5', undefined, ['openai', 'google']),
      ).toThrow('Provider "anthropic" is not allowed for this agent (allowed: openai, google)');
    });

    it('throws for every provider when allowedProviders is empty', () => {
      expect(() => resolveModelString('anthropic/claude-opus-4-5', undefined, [])).toThrow(
        'Provider "anthropic" is not allowed for this agent (allowed: none)',
      );
    });

    it('does not gate when allowedProviders is undefined (behaves exactly as today)', () => {
      const resolved = resolveModelString('anthropic/claude-opus-4-5', undefined, undefined);
      expect(resolved.id).toBe('claude-opus-4-5');
    });

    it('checks policy BEFORE the malformed-format error is irrelevant — bare id still fails on format', () => {
      // A bare id has no provider segment; the format error fires first (there is
      // no provider to gate), preserving the existing contract.
      expect(() => resolveModelString('claude-opus-4-5', undefined, ['anthropic'])).toThrow(
        /provider\/model/,
      );
    });
  });
});
