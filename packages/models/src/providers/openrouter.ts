import { FetcherError, type RawModel } from '../types.js';
import type { ProviderDefinition } from './types.js';

const DEFAULT_TIMEOUT_MS = 10_000;
const MODELS_URL = 'https://openrouter.ai/api/v1/models';

/**
 * Shape of one entry in OpenRouter's `GET /api/v1/models` response. Only the
 * fields we rely on are typed; OpenRouter returns many more (pricing,
 * context_length, top_provider, …) that we deliberately ignore so the
 * provider stays resilient to schema drift.
 */
interface OpenRouterModel {
  /** Namespaced slug, e.g. `anthropic/claude-opus-4.8` or `deepseek/deepseek-r1`. */
  id: string;
  /** Human display name, e.g. `Anthropic: Claude Opus 4.8`. */
  name?: string;
  /** Capabilities OpenRouter advertises for this model (e.g. `tools`, `reasoning`). */
  supported_parameters?: string[];
  architecture?: {
    /** Output modalities, e.g. `["text"]` for chat, `["image"]` for image gen. */
    output_modalities?: string[];
  };
}

interface OpenRouterModelsResponse {
  data?: OpenRouterModel[];
}

/**
 * OpenRouter provider — a single OpenAI-compatible gateway that fronts many
 * upstream vendors (Anthropic, OpenAI, Google, DeepSeek, Meta, Qwen, xAI, …).
 *
 * The provider id is `openrouter` — this is a hard constraint, not a style
 * choice: the bundled `@earendil-works/pi-ai` runtime resolves OpenRouter
 * models under the provider key `openrouter` (baseUrl
 * https://openrouter.ai/api/v1, `openai-completions` API), and its env-key map
 * points `openrouter` → `OPENROUTER_API_KEY`. The gateway credential store
 * collapses `<credentialPrefix-minus-"-api-key">` to the runtime provider, so
 * `id` and `credentialPrefix` must both encode `openrouter` for auth to reach
 * pi-ai. Using any other id makes models appear in discovery but fail at chat
 * time with "Unknown model".
 *
 * Model values are namespaced: `openrouter/<vendor>/<slug>` (e.g.
 * `openrouter/anthropic/claude-opus-4.8`). The agent backend splits on the
 * FIRST slash, so `provider` is `openrouter` and the modelId keeps the
 * `<vendor>/<slug>` namespace pi-ai expects.
 *
 * `fetchModels` filters to chat-capable, tool-using, text-output models and
 * drops `:`-suffixed variants (`:free`, `:thinking`, `:beta`, …) — the base
 * slug is the unthrottled, pi-ai-resolvable route; `:` variants are distinct
 * catalog entries that may be rate-limited or unresolvable. The curated
 * `SUPPORTED_MODELS` allow-list then narrows this to the verified set.
 */
export const OpenRouter: ProviderDefinition = {
  id: 'openrouter',
  label: 'OpenRouter',
  credentialPrefix: 'openrouter-api-key',

  async fetchModels(apiKey, signal): Promise<RawModel[]> {
    // OpenRouter's /models endpoint is public — it serves without auth. We send
    // a Bearer header only when a key is present (harmless, future-proofs) and
    // never hard-fail discovery on a missing key.
    const headers: Record<string, string> = {};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const res = await fetch(MODELS_URL, {
      headers,
      signal: signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new FetcherError(
        'openrouter',
        res.status,
        `OpenRouter /api/v1/models returned ${res.status} ${body}`.trimEnd(),
      );
    }

    const json = (await res.json()) as OpenRouterModelsResponse;
    return (json.data ?? []).filter(isAgentCapable).map((m) => ({
      provider: 'openrouter',
      id: m.id,
      label: m.name ?? m.id,
    }));
  },
};

/**
 * Keep only models an agent can actually drive: tool-calling capable, text
 * output, and a base (non-variant) slug. This is the authoritative capability
 * gate — `supported_parameters` comes straight from OpenRouter — so the
 * `SUPPORTED_MODELS` patterns only need to express family curation, not
 * capability checks.
 */
function isAgentCapable(m: OpenRouterModel): boolean {
  // Tool use is required — the agent loop depends on function calling. The
  // response body is an unvalidated cast, so guard with Array.isArray: a
  // malformed/proxied payload that makes this a non-array would otherwise throw
  // inside `.filter` and collapse the entire OpenRouter catalog out of discovery.
  if (!Array.isArray(m.supported_parameters) || !m.supported_parameters.includes('tools')) {
    return false;
  }
  // Require text output, but only when the modality list is actually declared.
  // A non-array, absent, or empty list is treated as "unknown" (kept), not
  // "no text" (dropped) — an empty `[]` is truthy and would otherwise silently
  // drop an allow-listed chat model.
  const out = m.architecture?.output_modalities;
  if (Array.isArray(out) && out.length > 0 && !out.includes('text')) return false;
  // Drop variant suffixes (`:free`, `:thinking`, `:beta`, …): rate-limited or
  // non-pi-ai-resolvable. The exact-id allow-list already excludes `:` variants
  // via anchored patterns, so this is a defensive guard that also future-proofs
  // any globbed pattern (where a trailing `*` would otherwise span the colon).
  if (m.id.includes(':')) return false;
  return true;
}
