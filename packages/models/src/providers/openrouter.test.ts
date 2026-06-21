import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FetcherError } from '../types.js';
import { OpenRouter } from './openrouter.js';

/** Build an OpenRouter /models entry with sane agent-capable defaults. */
function model(
  id: string,
  overrides: Partial<{
    name: string;
    supported_parameters: string[];
    output_modalities: string[];
  }> = {},
) {
  return {
    id,
    name: overrides.name ?? `Display: ${id}`,
    supported_parameters: overrides.supported_parameters ?? ['tools', 'reasoning'],
    architecture: { output_modalities: overrides.output_modalities ?? ['text'] },
  };
}

describe('OpenRouter provider', () => {
  const fetchSpy = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchSpy.mockReset();
  });

  it('fetches /api/v1/models and maps id + display name through, namespaced', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        data: [model('deepseek/deepseek-r1', { name: 'DeepSeek: R1' })],
      }),
      text: async () => '',
    });

    const models = await OpenRouter.fetchModels('sk-or-v1-fake');

    const [calledUrl] = fetchSpy.mock.calls[0];
    expect(String(calledUrl)).toBe('https://openrouter.ai/api/v1/models');
    expect(models).toEqual([
      { provider: 'openrouter', id: 'deepseek/deepseek-r1', label: 'DeepSeek: R1' },
    ]);
  });

  it('sends a Bearer header when a key is present', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ data: [] }),
      text: async () => '',
    });
    await OpenRouter.fetchModels('sk-or-v1-fake');
    const [, init] = fetchSpy.mock.calls[0];
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer sk-or-v1-fake' });
  });

  it('omits the Authorization header when no key is present (public endpoint)', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ data: [] }),
      text: async () => '',
    });
    await OpenRouter.fetchModels('');
    const [, init] = fetchSpy.mock.calls[0];
    expect((init as RequestInit).headers).not.toHaveProperty('Authorization');
  });

  it('keeps only tool-capable, text-output, non-variant models', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          model('deepseek/deepseek-r1'), // keep
          model('mistralai/mistral-large-2512'), // keep
          model('deepseek/deepseek-r1:free'), // drop — variant suffix
          model('openai/gpt-audio', { output_modalities: ['audio'] }), // drop — no text out
          model('google/gemini-3-pro-image', { output_modalities: ['image'] }), // drop — image out
          model('some/embedding-model', { supported_parameters: ['response_format'] }), // drop — no tools
        ],
      }),
      text: async () => '',
    });

    const models = await OpenRouter.fetchModels('sk-or-v1-fake');
    expect(models.map((m) => m.id)).toEqual([
      'deepseek/deepseek-r1',
      'mistralai/mistral-large-2512',
    ]);
  });

  it('tolerates malformed/empty capability fields without dropping the whole catalog', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          // Empty output_modalities → "unknown", kept (tool-capable, not dropped).
          {
            id: 'deepseek/deepseek-r1',
            name: 'R1',
            supported_parameters: ['tools'],
            architecture: { output_modalities: [] },
          },
          // Non-array output_modalities (schema drift) → must not throw; kept.
          {
            id: 'qwen/qwen3-max',
            name: 'Qwen',
            supported_parameters: ['tools'],
            architecture: { output_modalities: 'text' },
          },
          // Non-array supported_parameters → must not throw; dropped (no tools).
          {
            id: 'bad/model',
            name: 'bad',
            supported_parameters: 'tools',
            architecture: { output_modalities: ['text'] },
          },
        ],
      }),
      text: async () => '',
    });

    const models = await OpenRouter.fetchModels('');
    expect(models.map((m) => m.id)).toEqual(['deepseek/deepseek-r1', 'qwen/qwen3-max']);
  });

  it('falls back to id for label when name is absent', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        data: [{ id: 'qwen/qwen3-max', supported_parameters: ['tools'] }],
      }),
      text: async () => '',
    });
    const models = await OpenRouter.fetchModels('');
    expect(models).toEqual([
      { provider: 'openrouter', id: 'qwen/qwen3-max', label: 'qwen/qwen3-max' },
    ]);
  });

  it('returns an empty list when data is absent', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => '',
    });
    expect(await OpenRouter.fetchModels('')).toEqual([]);
  });

  it('throws FetcherError with provider id "openrouter" and status on non-2xx', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 429,
      json: async () => ({}),
      text: async () => 'rate limited',
    });

    let caught: unknown;
    try {
      await OpenRouter.fetchModels('sk-or-v1-bad');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FetcherError);
    const fe = caught as FetcherError;
    expect(fe.provider).toBe('openrouter');
    expect(fe.status).toBe(429);
  });

  it('declares id/credentialPrefix that match the pi-ai runtime provider key', () => {
    // CRITICAL: the runtime (pi-ai getModel + AuthStorage) keys on 'openrouter'.
    // The credential store collapses '<prefix>-api-key' → '<prefix>', so the
    // prefix MUST be 'openrouter-api-key' for auth to reach pi-ai.
    expect(OpenRouter.id).toBe('openrouter');
    expect(OpenRouter.credentialPrefix).toBe('openrouter-api-key');
  });
});
