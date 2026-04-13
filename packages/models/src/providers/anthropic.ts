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

/**
 * Detects Claude Code OAuth access tokens. These are issued by the
 * `claude /login` flow (not console.anthropic.com), look like
 * `sk-ant-oat01-...`, and authenticate via `Authorization: Bearer`
 * plus the `anthropic-beta: oauth-2025-04-20` header. Sending them
 * through the classic `x-api-key` header returns `401 invalid x-api-key`
 * even though the credential itself is valid. Classic API keys use the
 * `sk-ant-api03-` prefix.
 */
function isOauthToken(token: string): boolean {
  return token.startsWith('sk-ant-oat');
}

async function fetchAnthropicModels(
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<RawModel[]> {
  const res = await fetch('https://api.anthropic.com/v1/models', {
    headers,
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
}

export const Anthropic: ProviderDefinition = {
  id: 'anthropic',
  label: 'Anthropic',
  credentialPrefix: 'anthropic-api-key',

  async fetchModels(apiKey, signal): Promise<RawModel[]> {
    // OAuth token from Claude Code login → Bearer + oauth beta header.
    // The same /v1/models endpoint accepts both auth modes, so we only
    // swap headers (no Codex-style alternate URL needed here).
    if (isOauthToken(apiKey)) {
      return fetchAnthropicModels(
        {
          Authorization: `Bearer ${apiKey}`,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'oauth-2025-04-20',
        },
        signal,
      );
    }
    // Classic API key (sk-ant-api03-...) → x-api-key header.
    return fetchAnthropicModels(
      {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      signal,
    );
  },
};
