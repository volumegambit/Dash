import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FetcherError } from '../types.js';
import { Google } from './google.js';

describe('Google provider', () => {
  const fetchSpy = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchSpy.mockReset();
  });

  it('parses /v1beta/models response and strips models/ prefix', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        models: [
          { name: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro' },
          { name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash' },
        ],
      }),
      text: async () => '',
    });

    const models = await Google.fetchModels('AIza-fake');

    // Verify URL was constructed with key as query param
    const calledWith = fetchSpy.mock.calls[0][0];
    const url = calledWith instanceof URL ? calledWith : new URL(String(calledWith));
    expect(url.origin + url.pathname).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models',
    );
    expect(url.searchParams.get('key')).toBe('AIza-fake');

    expect(models).toEqual([
      { provider: 'google', id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
      { provider: 'google', id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
    ]);
  });

  it('falls back to bare id as label when displayName is missing', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ models: [{ name: 'models/gemini-no-name' }] }),
      text: async () => '',
    });
    const models = await Google.fetchModels('AIza');
    expect(models).toEqual([{ provider: 'google', id: 'gemini-no-name', label: 'gemini-no-name' }]);
  });

  it('handles entries without the models/ prefix', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ models: [{ name: 'gemini-bare' }] }),
      text: async () => '',
    });
    const models = await Google.fetchModels('AIza');
    expect(models[0].id).toBe('gemini-bare');
  });

  it('throws FetcherError with status on non-2xx', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 403,
      json: async () => ({}),
      text: async () => 'API key not valid',
    });

    let caught: unknown;
    try {
      await Google.fetchModels('AIza-bad');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FetcherError);
    const fe = caught as FetcherError;
    expect(fe.provider).toBe('google');
    expect(fe.status).toBe(403);
  });
});
