import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FetcherError } from '../types.js';
import { OpenAI } from './openai.js';

describe('OpenAI provider', () => {
  const fetchSpy = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchSpy.mockReset();
  });

  it('parses /v1/models response into RawModel[]', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          { id: 'gpt-5.4', object: 'model' },
          { id: 'text-embedding-3-small', object: 'model' },
        ],
      }),
      text: async () => '',
    });

    const models = await OpenAI.fetchModels('sk-fake');

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.openai.com/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer sk-fake' }),
      }),
    );
    // Non-chat models pass through — SUPPORTED_MODELS filters them later.
    expect(models).toEqual([
      { provider: 'openai', id: 'gpt-5.4', label: 'gpt-5.4' },
      { provider: 'openai', id: 'text-embedding-3-small', label: 'text-embedding-3-small' },
    ]);
  });

  it('throws FetcherError with status on non-2xx', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({}),
      text: async () => 'Invalid API key',
    });

    let caught: unknown;
    try {
      await OpenAI.fetchModels('sk-bad');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FetcherError);
    const fe = caught as FetcherError;
    expect(fe.provider).toBe('openai');
    expect(fe.status).toBe(401);
  });

  it('passes through caller-supplied AbortSignal', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ data: [] }),
      text: async () => '',
    });
    const ac = new AbortController();
    await OpenAI.fetchModels('sk', ac.signal);
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ signal: ac.signal }),
    );
  });
});
