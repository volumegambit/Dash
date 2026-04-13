import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FetcherError } from '../types.js';
import { Anthropic } from './anthropic.js';

describe('Anthropic provider', () => {
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
          { id: 'claude-opus-4-5-20260301', display_name: 'Claude Opus 4.5' },
          { id: 'claude-sonnet-4-5-20260301', display_name: 'Claude Sonnet 4.5' },
        ],
      }),
      text: async () => '',
    });

    const models = await Anthropic.fetchModels('sk-ant-fake');

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({
          'x-api-key': 'sk-ant-fake',
          'anthropic-version': '2023-06-01',
        }),
      }),
    );
    expect(models).toEqual([
      { provider: 'anthropic', id: 'claude-opus-4-5-20260301', label: 'Claude Opus 4.5' },
      { provider: 'anthropic', id: 'claude-sonnet-4-5-20260301', label: 'Claude Sonnet 4.5' },
    ]);
  });

  it('falls back to id as label when display_name is missing', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: 'claude-no-name' }] }),
      text: async () => '',
    });

    const models = await Anthropic.fetchModels('sk-ant-fake');
    expect(models).toEqual([
      { provider: 'anthropic', id: 'claude-no-name', label: 'claude-no-name' },
    ]);
  });

  it('throws FetcherError with status on non-2xx', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({}),
      text: async () => 'Unauthorized',
    });

    let caught: unknown;
    try {
      await Anthropic.fetchModels('sk-ant-bad');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FetcherError);
    const fe = caught as FetcherError;
    expect(fe.provider).toBe('anthropic');
    expect(fe.status).toBe(401);
    expect(fe.message).toContain('401');
  });

  it('passes through caller-supplied AbortSignal', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ data: [] }),
      text: async () => '',
    });
    const ac = new AbortController();
    await Anthropic.fetchModels('sk-ant', ac.signal);
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ signal: ac.signal }),
    );
  });

  // ------------------------------------------------------------------
  // Claude Code OAuth token fallback
  // ------------------------------------------------------------------

  it('routes sk-ant-oat OAuth tokens to Bearer auth + oauth-beta header', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        data: [{ id: 'claude-opus-4-6', display_name: 'Claude Opus 4.6' }],
      }),
      text: async () => '',
    });

    const oauthToken = 'sk-ant-oat01-aBcDeFgHiJkLmNoPqRsTuVwXyZ1234567890';
    const models = await Anthropic.fetchModels(oauthToken);

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: `Bearer ${oauthToken}`,
          'anthropic-beta': 'oauth-2025-04-20',
          'anthropic-version': '2023-06-01',
        }),
      }),
    );
    // Must NOT send x-api-key — that header on an OAuth token returns 401.
    const headers = fetchSpy.mock.calls[0][1].headers as Record<string, string>;
    expect(headers['x-api-key']).toBeUndefined();

    expect(models).toEqual([
      { provider: 'anthropic', id: 'claude-opus-4-6', label: 'Claude Opus 4.6' },
    ]);
  });

  it('classic sk-ant-api03 keys still use x-api-key (regression)', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ data: [] }),
      text: async () => '',
    });
    await Anthropic.fetchModels('sk-ant-api03-classic-key');
    const headers = fetchSpy.mock.calls[0][1].headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-ant-api03-classic-key');
    expect(headers.Authorization).toBeUndefined();
    expect(headers['anthropic-beta']).toBeUndefined();
  });
});
