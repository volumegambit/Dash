import type { FilteredModel } from '@dash/plugin-sdk';
import {
  type CatalogCredentialResolver,
  type ProviderConfigEntry,
  discoverCatalogModels,
  newestCatalogReviewedAt,
} from '@dash/plugins';
import { Hono } from 'hono';
import type { GatewayCredentialStore } from './credential-store.js';
import type { ModelsStore } from './models-store.js';
import { appendPluginModels, expandPluginModelsForRoute } from './plugin-providers.js';

/**
 * Response shape returned by `GET /models` and `POST /models/refresh`.
 * The MC wire contract — field names and shapes are unchanged from the
 * previous `@dash/models`-backed route.
 */
export interface ModelsRouteResponse {
  models: FilteredModel[];
  source: 'live' | 'bootstrap';
  errors: Record<string, string>;
  fetchedAt: string;
  supportedModelsReviewedAt: string;
}

export interface ModelsDebugResponse extends ModelsRouteResponse {
  bootstrap: FilteredModel[];
  patterns: Array<{ provider: string; pattern: string; tier: number }>;
  providersConfigured: string[];
  providersAvailable: string[];
}

export interface ModelsRouteOptions {
  store: ModelsStore;
  credentialStore: GatewayCredentialStore;
  /**
   * Live wiring getter — read PER-REQUEST so plugin hot-reload is reflected on
   * the next `GET /models` without a restart. Provides the loaded provider
   * catalogs the route discovers against and whose static models it merges at
   * render time.
   */
  getProviderConfigs: () => ProviderConfigEntry[];
  /** Test override for `discoverCatalogModels`. */
  discover?: typeof discoverCatalogModels;
}

/**
 * Build a Hono sub-app exposing `GET /models` and `POST /models/refresh`.
 *
 * `GET /models` reads the persisted store and returns immediately on a hit. On
 * a miss (no file, the catalog fingerprint moved, or after an explicit
 * invalidation), it triggers a live fetch via `discoverCatalogModels` against
 * the loaded provider catalogs, persists the result, and returns. When no
 * provider credentials are configured at all, returns `source: 'bootstrap'`
 * with an empty `models` — the render-time merge below fills in every catalog's
 * static models, which IS the bootstrap list now (there is no separate
 * BOOTSTRAP_MODELS constant).
 *
 * `POST /models/refresh` always triggers a fresh discover. Used by MC's refresh
 * button and by callers that want to force-refetch after credentials change.
 *
 * The cold-fetch path is mutex-guarded so concurrent callers share one fetch
 * instead of all racing to hit provider /v1/models endpoints.
 */
export function createModelsRoute(options: ModelsRouteOptions): Hono {
  const { store, credentialStore } = options;
  const discover = options.discover ?? discoverCatalogModels;
  const app = new Hono();

  // Read the loaded catalogs LIVE on each request so a plugin hot-reload that
  // adds/removes a provider is reflected without a restart.
  const catalogs = () => options.getProviderConfigs().map((p) => p.catalog);

  // Promise mutex — when a refresh is in flight, all callers share it.
  let inFlight: Promise<ModelsRouteResponse> | null = null;

  /**
   * Resolve a catalog credential from the encrypted store. Reads lazily so
   * the store isn't decrypted until discover actually wants a provider.
   */
  const credentialResolver: CatalogCredentialResolver = async (catalogId) => {
    const keys = await credentialStore.readProviderApiKeys();
    return keys[catalogId] ?? null;
  };

  async function refreshNow(): Promise<ModelsRouteResponse> {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const fingerprint = newestCatalogReviewedAt(catalogs());
      const result = await discover(catalogs(), credentialResolver);
      const fetchedAt = new Date().toISOString();
      if (result.providersConfigured === 0) {
        // No credentials configured at all → serve an empty live list tagged
        // `bootstrap`. Do NOT persist it: the render-time merge below fills in
        // every catalog's static models (the bootstrap list), and the moment a
        // credential is added the next refresh overwrites cleanly.
        return {
          models: [],
          source: 'bootstrap' as const,
          errors: {},
          fetchedAt,
          supportedModelsReviewedAt: fingerprint,
        };
      }
      // At least one provider had a credential — persist whatever we got back
      // (could include errors for some providers).
      await store.save(result.models, fingerprint);
      return {
        models: result.models,
        source: 'live' as const,
        errors: result.errors,
        fetchedAt,
        supportedModelsReviewedAt: fingerprint,
      };
    })();
    try {
      return await inFlight;
    } finally {
      inFlight = null;
    }
  }

  async function getOrRefresh(): Promise<ModelsRouteResponse> {
    const stored = await store.load(newestCatalogReviewedAt(catalogs()));
    if (stored && stored.models.length > 0) {
      return {
        models: stored.models,
        source: 'live',
        errors: {},
        fetchedAt: stored.fetchedAt,
        supportedModelsReviewedAt: stored.supportedModelsReviewedAt,
      };
    }
    return refreshNow();
  }

  // Merge every catalog's static models into a response at render time (never
  // persisted): live core models win on a value clash, plugin/static models are
  // appended in dropdown order. This IS the bootstrap list on the zero-credential
  // path, and the deduped append of static ids on the live path.
  const withStaticModels = (resp: ModelsRouteResponse): ModelsRouteResponse =>
    appendPluginModels(resp, expandPluginModelsForRoute(options.getProviderConfigs()));

  app.get('/', async (c) => {
    if (c.req.query('debug') === 'true') {
      const response = withStaticModels(await getOrRefresh());
      const credentials = await credentialStore.readProviderApiKeys();
      const providersConfigured = Object.keys(credentials);
      const cats = catalogs();
      const debug: ModelsDebugResponse = {
        ...response,
        bootstrap: expandPluginModelsForRoute(options.getProviderConfigs()),
        patterns: cats.flatMap((cat) =>
          (cat.supportedPatterns ?? []).map((p) => ({
            provider: cat.id,
            pattern: p.pattern,
            tier: p.tier,
          })),
        ),
        providersConfigured,
        providersAvailable: cats.map((cat) => cat.id),
      };
      return c.json(debug);
    }
    return c.json(withStaticModels(await getOrRefresh()));
  });

  app.post('/refresh', async (c) => {
    // Force-fresh: clear in-flight (so a stale refresh from before a credential
    // change doesn't get joined) and run a new discover.
    inFlight = null;
    return c.json(withStaticModels(await refreshNow()));
  });

  return app;
}
