import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type CredentialResolver, discoverModels } from './discover.js';
import { FetcherError } from './types.js';

describe('discoverModels', () => {
  const fetchSpy = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchSpy.mockReset();
  });

  function withCredentials(creds: Record<string, string>): CredentialResolver {
    return async (provider) => creds[provider.id] ?? null;
  }

  it('returns empty models with no errors when no credentials are configured', async () => {
    const result = await discoverModels(async () => null);
    expect(result.models).toEqual([]);
    expect(result.errors).toEqual({});
    expect(result.providersConfigured).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fetches from configured providers and applies the filter', async () => {
    fetchSpy.mockImplementation(async (url: string | URL) => {
      const u = url instanceof URL ? url : new URL(String(url));
      if (u.hostname === 'api.anthropic.com') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [
              { id: 'claude-opus-4-5-20260301', display_name: 'Claude Opus 4.5' },
              { id: 'claude-haiku-4-5-20260301', display_name: 'Claude Haiku 4.5' },
            ],
          }),
          text: async () => '',
        };
      }
      return { ok: false, status: 404, text: async () => '', json: async () => ({}) };
    });

    const result = await discoverModels(withCredentials({ anthropic: 'sk-ant' }));
    expect(result.providersConfigured).toBe(1);
    expect(result.errors).toEqual({});
    expect(result.models.map((m) => m.value)).toEqual([
      'anthropic/claude-opus-4-5-20260301',
      'anthropic/claude-haiku-4-5-20260301',
    ]);
  });

  it('records per-provider error and continues with other providers', async () => {
    fetchSpy.mockImplementation(async (url: string | URL) => {
      const u = url instanceof URL ? url : new URL(String(url));
      if (u.hostname === 'api.anthropic.com') {
        // Anthropic 401
        return {
          ok: false,
          status: 401,
          text: async () => 'Unauthorized',
          json: async () => ({}),
        };
      }
      if (u.hostname === 'api.openai.com') {
        // OpenAI succeeds
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [{ id: 'gpt-5.4' }],
          }),
          text: async () => '',
        };
      }
      return { ok: false, status: 404, text: async () => '', json: async () => ({}) };
    });

    const result = await discoverModels(
      withCredentials({ anthropic: 'sk-ant', openai: 'sk-openai' }),
    );
    expect(result.providersConfigured).toBe(2);
    expect(result.errors.anthropic).toContain('401');
    expect(result.errors.openai).toBeUndefined();
    expect(result.models.map((m) => m.value)).toEqual(['openai/gpt-5.4']);
  });

  it('wraps non-FetcherError exceptions into the errors map', async () => {
    fetchSpy.mockImplementation(async () => {
      throw new TypeError('network unreachable');
    });

    const result = await discoverModels(withCredentials({ anthropic: 'sk-ant' }));
    expect(result.errors.anthropic).toContain('network unreachable');
    expect(result.models).toEqual([]);
  });

  it('FetcherError surfaces with its full message', async () => {
    fetchSpy.mockImplementation(async () => {
      throw new FetcherError('anthropic', 500, 'Anthropic /v1/models returned 500 internal');
    });
    const result = await discoverModels(withCredentials({ anthropic: 'sk-ant' }));
    expect(result.errors.anthropic).toBe('Anthropic /v1/models returned 500 internal');
  });
});
