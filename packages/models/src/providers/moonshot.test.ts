import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FetcherError } from '../types.js';
import { Moonshot } from './moonshot.js';

describe('Moonshot provider', () => {
  const fetchSpy = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchSpy.mockReset();
  });

  it('parses the OpenAI-shaped /v1/models response with a Bearer header', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        data: [{ id: 'kimi-k2-thinking' }, { id: 'kimi-latest' }, { id: 'moonshot-v1-128k' }],
      }),
      text: async () => '',
    });

    const models = await Moonshot.fetchModels('sk-fake');

    // Hits the global Moonshot base URL with a Bearer auth header.
    const [calledUrl, init] = fetchSpy.mock.calls[0];
    expect(String(calledUrl)).toBe('https://api.moonshot.ai/v1/models');
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer sk-fake',
    });

    // ids passed through as both id and label (Moonshot has no display names).
    expect(models).toEqual([
      { provider: 'moonshotai', id: 'kimi-k2-thinking', label: 'kimi-k2-thinking' },
      { provider: 'moonshotai', id: 'kimi-latest', label: 'kimi-latest' },
      { provider: 'moonshotai', id: 'moonshot-v1-128k', label: 'moonshot-v1-128k' },
    ]);
  });

  it('returns an empty list when data is absent', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => '',
    });
    const models = await Moonshot.fetchModels('sk-fake');
    expect(models).toEqual([]);
  });

  it('throws FetcherError with provider id "moonshotai" and status on non-2xx', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({}),
      text: async () => 'invalid api key',
    });

    let caught: unknown;
    try {
      await Moonshot.fetchModels('sk-bad');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FetcherError);
    const fe = caught as FetcherError;
    expect(fe.provider).toBe('moonshotai');
    expect(fe.status).toBe(401);
  });

  it('declares id/credentialPrefix that match the pi-ai runtime provider key', () => {
    // CRITICAL: the runtime (pi-ai getModel + AuthStorage) keys on 'moonshotai'.
    // The credential store collapses '<prefix>-api-key' → '<prefix>', so the
    // prefix MUST be 'moonshotai-api-key' for auth to reach pi-ai.
    expect(Moonshot.id).toBe('moonshotai');
    expect(Moonshot.credentialPrefix).toBe('moonshotai-api-key');
  });
});
