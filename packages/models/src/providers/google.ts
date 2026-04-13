import { FetcherError, type RawModel } from '../types.js';
import type { ProviderDefinition } from './types.js';

const DEFAULT_TIMEOUT_MS = 10_000;

interface GoogleModelsResponse {
  models: Array<{
    name: string; // "models/gemini-pro" — the `models/` prefix gets stripped
    displayName?: string;
    supportedGenerationMethods?: string[];
  }>;
}

export const Google: ProviderDefinition = {
  id: 'google',
  label: 'Google',
  credentialPrefix: 'google-api-key',

  async fetchModels(apiKey, signal): Promise<RawModel[]> {
    // Google's Gemini API takes the key as a query param, not a header.
    const url = new URL('https://generativelanguage.googleapis.com/v1beta/models');
    url.searchParams.set('key', apiKey);
    const res = await fetch(url, {
      signal: signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new FetcherError(
        'google',
        res.status,
        `Google /v1beta/models returned ${res.status} ${body}`.trimEnd(),
      );
    }
    const json = (await res.json()) as GoogleModelsResponse;
    return (json.models ?? []).map((m) => {
      // `name` comes back as e.g. "models/gemini-pro" — strip the prefix
      // so consumers see the bare id, matching the other providers.
      const id = m.name.startsWith('models/') ? m.name.slice('models/'.length) : m.name;
      return {
        provider: 'google',
        id,
        label: m.displayName ?? id,
      };
    });
  },
};
