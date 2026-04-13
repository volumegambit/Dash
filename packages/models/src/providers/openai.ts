import { FetcherError, type RawModel } from '../types.js';
import type { ProviderDefinition } from './types.js';

const DEFAULT_TIMEOUT_MS = 10_000;

interface OpenAIModelsResponse {
  data: Array<{
    id: string;
  }>;
}

export const OpenAI: ProviderDefinition = {
  id: 'openai',
  label: 'OpenAI',
  credentialPrefix: 'openai-api-key',

  async fetchModels(apiKey, signal): Promise<RawModel[]> {
    const res = await fetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new FetcherError(
        'openai',
        res.status,
        `OpenAI /v1/models returned ${res.status} ${body}`.trimEnd(),
      );
    }
    const json = (await res.json()) as OpenAIModelsResponse;
    // OpenAI doesn't expose display names. Pass everything through —
    // SUPPORTED_MODELS patterns filter out non-chat models (embeddings,
    // audio, image gen, etc.) downstream.
    return (json.data ?? []).map((m) => ({
      provider: 'openai',
      id: m.id,
      label: m.id,
    }));
  },
};
