import { type Api, type Model, getModel } from '@earendil-works/pi-ai';
import type { PluginModelCatalog } from '../types.js';

/**
 * Resolve `provider/model-id` to a concrete pi-ai Model. The plugin catalog
 * is consulted FIRST so catalogs own their ids (a catalog can carry fresher
 * metadata than pi-ai's baked registry — cost, context window, headers);
 * pi-ai's static registry is the fallback for anything catalogs don't
 * declare. Pure: all inputs explicit, no backend state.
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
    if (m) return m as Model<Api>;
  }
  // biome-ignore lint/suspicious/noExplicitAny: getModel requires generic provider/modelId that are not statically known
  const model = getModel(provider as any, modelId as any);
  if (model) return model;
  throw new Error(`Unknown model "${modelStr}". Check that the provider and model ID are correct.`);
}
