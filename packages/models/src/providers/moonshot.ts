import { FetcherError, type RawModel } from '../types.js';
import type { ProviderDefinition } from './types.js';

const DEFAULT_TIMEOUT_MS = 10_000;

interface MoonshotModelsResponse {
  data: Array<{
    id: string;
  }>;
}

/**
 * Moonshot AI (Kimi) provider.
 *
 * The provider id is `moonshotai` — NOT `kimi` or `moonshot`. This is a hard
 * constraint, not a style choice: the bundled `@earendil-works/pi-ai` runtime
 * resolves Moonshot models under the provider key `moonshotai` (baseUrl
 * https://api.moonshot.ai/v1, `openai-completions` API), and its env-key map
 * points `moonshotai` → `MOONSHOT_API_KEY`. The gateway credential store
 * collapses `<credentialPrefix-minus-"-api-key">` to the runtime provider,
 * so `id` and `credentialPrefix` must both encode `moonshotai` for auth to
 * reach pi-ai. Using any other id makes models appear in discovery but fail
 * at chat time with "Unknown model".
 *
 * Moonshot is OpenAI-compatible: GET /v1/models with `Authorization: Bearer`
 * returns the standard `{ data: [{ id }] }` shape.
 */
export const Moonshot: ProviderDefinition = {
  id: 'moonshotai',
  label: 'Moonshot (Kimi)',
  credentialPrefix: 'moonshotai-api-key',

  async fetchModels(apiKey, signal): Promise<RawModel[]> {
    const res = await fetch('https://api.moonshot.ai/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new FetcherError(
        'moonshotai',
        res.status,
        `Moonshot /v1/models returned ${res.status} ${body}`.trimEnd(),
      );
    }
    const json = (await res.json()) as MoonshotModelsResponse;
    // Moonshot doesn't expose display names. Pass ids through —
    // SUPPORTED_MODELS patterns filter non-chat models downstream.
    return (json.data ?? []).map((m) => ({
      provider: 'moonshotai',
      id: m.id,
      label: m.id,
    }));
  },
};
