import { type Api, type Model, getModel } from '@earendil-works/pi-ai';
import type { PluginModelCatalog } from '../types.js';

/**
 * Resolve `provider/model-id` to a concrete pi-ai Model. The plugin catalog
 * is consulted FIRST so catalogs own their ids (a catalog can carry fresher
 * metadata than pi-ai's baked registry — cost, context window, headers);
 * pi-ai's static registry is the fallback for anything catalogs don't
 * declare. Pure: all inputs explicit, no backend state.
 */
export function resolveModelString(
  modelStr: string,
  pluginModelCatalog: PluginModelCatalog | undefined,
): Model<Api> {
  const slash = modelStr.indexOf('/');
  if (slash === -1) {
    throw new Error(
      `Model must be in "provider/model" format, got "${modelStr}". Example: "anthropic/claude-sonnet-4-20250514"`,
    );
  }
  const provider = modelStr.slice(0, slash);
  const modelId = modelStr.slice(slash + 1);
  if (pluginModelCatalog) {
    const m = pluginModelCatalog.resolve(provider, modelId);
    if (m) return m as Model<Api>;
  }
  // biome-ignore lint/suspicious/noExplicitAny: getModel requires generic provider/modelId that are not statically known
  const model = getModel(provider as any, modelId as any);
  if (model) return model;
  throw new Error(`Unknown model "${modelStr}". Check that the provider and model ID are correct.`);
}
