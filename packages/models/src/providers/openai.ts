import { FetcherError, type RawModel } from '../types.js';
import type { ProviderDefinition } from './types.js';

const DEFAULT_TIMEOUT_MS = 10_000;

interface OpenAIModelsResponse {
  data: Array<{
    id: string;
  }>;
}

interface CodexModelsResponse {
  models: Array<{
    slug: string;
    display_name?: string;
  }>;
}

/**
 * Detects ChatGPT/Codex OAuth tokens — JWTs scoped for ChatGPT's
 * backend, NOT regular `sk-...` API keys. They look like
 * `eyJhbGciOi...` (JWT prefix). The token MC stores under
 * `openai-api-key:default` is one of these whenever the user
 * authenticates via the OpenAI OAuth flow rather than pasting a
 * classic API key.
 */
function looksLikeJwt(token: string): boolean {
  return token.startsWith('eyJ') && token.split('.').length === 3;
}

async function fetchFromOpenAI(apiKey: string, signal?: AbortSignal): Promise<RawModel[]> {
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
}

/**
 * Fetch models via ChatGPT's Codex backend endpoint instead of the
 * regular OpenAI public API. The Codex OAuth token can call this
 * endpoint but cannot call `api.openai.com/v1/models` (the latter
 * requires the `api.model.read` scope which Codex tokens don't carry).
 *
 * Used as a fallback when the public endpoint returns 403 — covers the
 * common case where a user authenticated via the OpenAI OAuth flow in
 * MC and stored a JWT under `openai-api-key:default`.
 */
async function fetchFromCodexBackend(apiKey: string, signal?: AbortSignal): Promise<RawModel[]> {
  const url = new URL('https://chatgpt.com/backend-api/codex/models');
  // The endpoint requires a client_version query param; any value works
  // but newer versions return richer response shapes. We only consume
  // `slug` + `display_name` so the version we pick doesn't change the
  // mapping.
  url.searchParams.set('client_version', '2.0.0');
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new FetcherError(
      'openai',
      res.status,
      `OpenAI codex /models returned ${res.status} ${body}`.trimEnd(),
    );
  }
  const json = (await res.json()) as CodexModelsResponse;
  return (json.models ?? []).map((m) => ({
    provider: 'openai',
    id: m.slug,
    label: m.display_name ?? m.slug,
  }));
}

export const OpenAI: ProviderDefinition = {
  id: 'openai',
  label: 'OpenAI',
  credentialPrefix: 'openai-api-key',

  async fetchModels(apiKey, signal): Promise<RawModel[]> {
    // Fast path: classic `sk-...` API key → call the public endpoint.
    if (!looksLikeJwt(apiKey)) {
      return fetchFromOpenAI(apiKey, signal);
    }
    // JWT (Codex / ChatGPT OAuth token) → these can't authenticate
    // against `/v1/models` (missing `api.model.read` scope), but they
    // CAN call the Codex backend's models endpoint. Try that directly.
    try {
      return await fetchFromCodexBackend(apiKey, signal);
    } catch (err) {
      // If the Codex endpoint also fails, fall back to the public
      // endpoint so the error message points at the more familiar URL.
      if (err instanceof FetcherError && err.status === 403) {
        return fetchFromOpenAI(apiKey, signal);
      }
      throw err;
    }
  },
};
