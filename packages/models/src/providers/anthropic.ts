import { FetcherError, type RawModel } from '../types.js';
import type { ProviderDefinition } from './types.js';

/**
 * Default timeout for provider /models calls. The gateway hits these
 * endpoints during the cold-start path of a `GET /models` request, so
 * keeping it bounded prevents a slow provider from wedging MC's first
 * dropdown render.
 */
const DEFAULT_TIMEOUT_MS = 10_000;

interface AnthropicModelsResponse {
  data: Array<{
    id: string;
    display_name?: string;
  }>;
}

export const Anthropic: ProviderDefinition = {
  id: 'anthropic',
  label: 'Anthropic',
  credentialPrefix: 'anthropic-api-key',

  async fetchModels(apiKey, signal): Promise<RawModel[]> {
    const res = await fetch('https://api.anthropic.com/v1/models', {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      signal: signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new FetcherError(
        'anthropic',
        res.status,
        `Anthropic /v1/models returned ${res.status} ${body}`.trimEnd(),
      );
    }
    const json = (await res.json()) as AnthropicModelsResponse;
    return (json.data ?? []).map((m) => ({
      provider: 'anthropic',
      id: m.id,
      label: m.display_name ?? m.id,
    }));
  },
};
