import type { PluginModelCatalog } from '@dash/agent';
import type { CatalogModel, FilteredModel, ProviderCatalog } from '@dash/plugin-sdk';
import { type ProviderConfigEntry, catalogSortKey } from '@dash/plugins';
import type { Api, Model } from '@earendil-works/pi-ai';
import type { ModelsRouteResponse } from './models-route.js';

/**
 * Build a pi-ai `Model<Api>` from a plugin's provider catalog + one of its
 * models. Constructed with proper typing (only `compat` needs a narrow cast,
 * since its type is conditional on the api literal and `Api` widens it to
 * `never`) so the field mapping is compile-time-checked even though the
 * `PluginModelCatalog.resolve` interface erases the result to `unknown`.
 */
export function buildModel(catalog: ProviderCatalog, model: CatalogModel): Model<Api> {
  return {
    id: model.id,
    name: model.name ?? model.id,
    api: catalog.api,
    provider: catalog.id,
    baseUrl: catalog.baseUrl,
    reasoning: model.reasoning ?? false,
    input: model.input ?? ['text'],
    cost: model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    headers: model.headers,
    compat: model.compat as Model<Api>['compat'],
  };
}

/**
 * Defense-in-depth: the reserved (core) provider ids belong exclusively to the
 * bundled owner plugin (`dash-core-providers`). A plugin id is only validated
 * kebab-case, so nothing stops a trusted third-party plugin declaring
 * `id: 'anthropic'` — which would let it shadow the reserved namespace
 * (injecting a `placeholderKey` under the core id, or intercepting unknown
 * `anthropic/<model>` ids via the plugin catalog's `baseUrl`). A reserved id
 * is kept only when `entry.pluginName === ownerPluginName`; from any other
 * plugin it is dropped, even when trusted. Non-reserved ids always pass.
 * Returns non-colliding catalogs as `safe` and colliding ones as `dropped`.
 * Comparison is case-insensitive. Pure.
 */
export function excludeCoreProviderCollisions(
  providerConfigs: ProviderConfigEntry[],
  reservedIds: Iterable<string>,
  ownerPluginName: string,
): { safe: ProviderConfigEntry[]; dropped: ProviderConfigEntry[] } {
  const reserved = new Set<string>();
  for (const id of reservedIds) {
    reserved.add(id.toLowerCase());
  }
  const safe: ProviderConfigEntry[] = [];
  const dropped: ProviderConfigEntry[] = [];
  for (const entry of providerConfigs) {
    if (reserved.has(entry.catalog.id.toLowerCase()) && entry.pluginName !== ownerPluginName) {
      dropped.push(entry);
    } else {
      safe.push(entry);
    }
  }
  return { safe, dropped };
}

/**
 * Assemble a `PluginModelCatalog` from the loaded plugins' provider catalogs.
 * Catalogs are indexed by `catalog.id` (the `<provider>/<model>` provider
 * segment). `resolve(provider, modelId)` finds the catalog for the provider,
 * then the model by `id`; if the model isn't listed but the catalog declares
 * `dynamicModels`, it synthesizes one sized from `dynamicModelDefaults`
 * (returning null when no defaults are present — an un-sizable model). The
 * result is the pi-ai `Model<Api>` the backend's `resolveModel` fallback uses
 * to route to an arbitrary plugin provider; null when nothing matches.
 */
export function createPluginModelCatalog(
  providerConfigs: ProviderConfigEntry[],
): PluginModelCatalog {
  const byId = new Map<string, ProviderCatalog>();
  for (const { catalog } of providerConfigs) {
    byId.set(catalog.id, catalog);
  }

  return {
    resolve(provider: string, modelId: string): unknown {
      const catalog = byId.get(provider);
      if (!catalog) return null;

      const known = catalog.models.find((m) => m.id === modelId);
      if (known) return buildModel(catalog, known);

      if (catalog.dynamicModels && catalog.dynamicModelDefaults) {
        const synthesized: CatalogModel = {
          id: modelId,
          contextWindow: catalog.dynamicModelDefaults.contextWindow,
          maxTokens: catalog.dynamicModelDefaults.maxTokens,
        };
        return buildModel(catalog, synthesized);
      }

      return null;
    },
  };
}

/**
 * Flatten every catalog's statically-known models into `FilteredModel` entries
 * for the model dropdown. Dynamic-only model ids aren't enumerable, so only the
 * declared `models` appear — that's correct: the dropdown lists concrete
 * choices, while dynamic ids stay resolvable on demand via the catalog.
 *
 * Input is sorted by `catalogSortKey` first ([ui.sortOrder ?? MAX, id]) so the
 * dropdown order is stable and matches the live-discovery ordering.
 */
export function expandPluginModelsForRoute(
  providerConfigs: ProviderConfigEntry[],
): FilteredModel[] {
  const sorted = [...providerConfigs].sort((a, b) => {
    const [ao, aid] = catalogSortKey(a.catalog);
    const [bo, bid] = catalogSortKey(b.catalog);
    return ao !== bo ? ao - bo : aid.localeCompare(bid);
  });
  const out: FilteredModel[] = [];
  for (const { catalog } of sorted) {
    for (const model of catalog.models) {
      out.push({
        value: `${catalog.id}/${model.id}`,
        label: model.name ?? model.id,
        provider: catalog.id,
      });
    }
  }
  return out;
}

/**
 * Merge plugin-contributed models into a models-route response at render time.
 * Plugin models are appended AFTER the core models, and any plugin model whose
 * `value` already exists is dropped (core wins — a plugin must never shadow a
 * core model id). Returns the original response unchanged when there are no
 * plugin models. This is deliberately render-time only: plugin models are
 * NEVER persisted to the models store, so removing a plugin cleanly drops its
 * models without leaving stale entries behind.
 */
export function appendPluginModels(
  resp: ModelsRouteResponse,
  pluginModels: FilteredModel[] | undefined,
): ModelsRouteResponse {
  if (!pluginModels || pluginModels.length === 0) return resp;
  const seen = new Set(resp.models.map((m) => m.value));
  const additions = pluginModels.filter((m) => !seen.has(m.value));
  if (additions.length === 0) return resp;
  return { ...resp, models: [...resp.models, ...additions] };
}
