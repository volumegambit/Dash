import { type Api, type Model, getModel } from '@earendil-works/pi-ai';
import type { PluginModelCatalog } from '../types.js';

/**
 * Attribution headers sent on every OpenRouter API request so OpenRouter's
 * dashboard attributes traffic to Dash (not to a generic OpenAI SDK client).
 * These are OpenRouter's standard optional headers:
 *   - HTTP-Referer: the app's site URL
 *   - X-Title: the app name shown on OpenRouter's dashboard
 *
 * Applied here (in resolveModelString) rather than in pi-ai or pi-coding-agent
 * so it covers BOTH resolution paths — the plugin catalog and pi-ai's static
 * registry — without modifying the third-party SDK. The headers are merged
 * onto whatever the model already carries so catalog/registry headers are
 * preserved.
 */
const OPENROUTER_ATTRIBUTION_HEADERS: Record<string, string> = {
  'HTTP-Referer': 'https://www.dashsquad.ai',
  'X-Title': 'DashSquad',
};

/**
 * Returns true when the model routes to OpenRouter — either by provider id or
 * by baseUrl hostname. Mirrors pi-ai's own isOpenRouterModel detection.
 */
function isOpenRouterModel(model: Model<Api>): boolean {
  return model.provider === 'openrouter' || (model.baseUrl ?? '').includes('openrouter.ai');
}

/**
 * Inject Dash attribution headers for OpenRouter models. For non-OpenRouter
 * models the model is returned unchanged. The attribution headers are merged
 * AFTER the model's existing headers so a catalog or registry can override
 * them if needed, but by default Dash identifies itself on every OpenRouter
 * request.
 */
function withAttributionHeaders(model: Model<Api>): Model<Api> {
  if (!isOpenRouterModel(model)) return model;
  return {
    ...model,
    headers: {
      ...OPENROUTER_ATTRIBUTION_HEADERS,
      ...(model.headers ?? {}),
    },
  };
}

/**
 * Resolve `provider/model-id` to a concrete pi-ai Model. The plugin catalog
 * is consulted FIRST so catalogs own their ids (a catalog can carry fresher
 * metadata than pi-ai's baked registry — cost, context window, headers);
 * pi-ai's static registry is the fallback for anything catalogs don't
 * declare. Pure: all inputs explicit, no backend state.
 *
 * For OpenRouter models, Dash attribution headers (`HTTP-Referer`,
 * `X-Title`) are injected so OpenRouter's dashboard attributes traffic to
 * DashSquad rather than showing a generic OpenAI SDK client.
 *
 * `allowedProviders` gates which provider segments this agent may use. It is
 * checked FIRST — before any catalog/pi-ai lookup — so a disallowed provider
 * reports a policy error even when the model genuinely exists. `undefined`
 * means no gating (the historical behavior); `[]` disallows every provider;
 * otherwise the provider segment must be a member.
 */
export function resolveModelString(
  modelStr: string,
  pluginModelCatalog: PluginModelCatalog | undefined,
  allowedProviders?: string[],
): Model<Api> {
  const slash = modelStr.indexOf('/');
  if (slash === -1) {
    throw new Error(
      `Model must be in "provider/model" format, got "${modelStr}". Example: "anthropic/claude-sonnet-4-20250514"`,
    );
  }
  const provider = modelStr.slice(0, slash);
  const modelId = modelStr.slice(slash + 1);
  // Policy gate: enforced BEFORE catalog/pi-ai lookup so a disallowed provider
  // yields a distinct policy error (not "Unknown model"), even for a model that
  // exists. `undefined` = no gating; `[]` = nothing allowed.
  if (allowedProviders !== undefined && !allowedProviders.includes(provider)) {
    throw new Error(
      `Provider "${provider}" is not allowed for this agent (allowed: ${allowedProviders.join(', ') || 'none'})`,
    );
  }
  if (pluginModelCatalog) {
    const m = pluginModelCatalog.resolve(provider, modelId);
    if (m) return withAttributionHeaders(m as Model<Api>);
  }
  // biome-ignore lint/suspicious/noExplicitAny: getModel requires generic provider/modelId that are not statically known
  const model = getModel(provider as any, modelId as any);
  if (model) return withAttributionHeaders(model);
  throw new Error(`Unknown model "${modelStr}". Check that the provider and model ID are correct.`);
}
