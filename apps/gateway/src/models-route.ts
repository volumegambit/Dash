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
 * previous curated-allow-list route (now backed by the bundled
 * dash-core-providers catalogs via `@dash/plugins`).
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

export interface ModelsControllerOptions {
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

export interface ModelsRouteController {
  get(): Promise<ModelsRouteResponse>;
  refresh(): Promise<ModelsRouteResponse>;
  debug(): Promise<ModelsDebugResponse>;
}

export interface ModelsRouteOptions extends ModelsControllerOptions {
  /** Expose only the frozen mobile GET shape, without debug or refresh extensions. */
  strictReadOnly?: boolean;
  /** Share discovery, persistence, and the in-flight request across mounted route aliases. */
  controller?: ModelsRouteController;
}

/**
 * Build the shared model discovery and cache controller used by one or more
 * HTTP route views.
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
export function createModelsController(options: ModelsControllerOptions): ModelsRouteController {
  const { store, credentialStore } = options;
  const discover = options.discover ?? discoverCatalogModels;

  // Promise mutex shared by every HTTP surface backed by this controller.
  let inFlight: Promise<ModelsRouteResponse> | null = null;
  let generation = 0;

  /**
   * Resolve a catalog credential from the encrypted store. Reads lazily so
   * the store isn't decrypted until discover actually wants a provider.
   */
  const credentialResolver: CatalogCredentialResolver = async (catalogId) => {
    const keys = await credentialStore.readProviderApiKeys();
    return keys[catalogId] ?? null;
  };

  const withStaticModels = (
    response: ModelsRouteResponse,
    providerConfigs: ProviderConfigEntry[],
  ): ModelsRouteResponse =>
    appendPluginModels(response, expandPluginModelsForRoute(providerConfigs));

  function track(
    operation: (operationGeneration: number) => Promise<ModelsRouteResponse>,
  ): Promise<ModelsRouteResponse> {
    const operationGeneration = ++generation;
    const tracked = operation(operationGeneration).finally(() => {
      if (inFlight === tracked) inFlight = null;
    });
    inFlight = tracked;
    return tracked;
  }

  async function discoverAndRender(
    providerConfigs: ProviderConfigEntry[],
    operationGeneration: number,
  ): Promise<ModelsRouteResponse> {
    const catalogs = providerConfigs.map((provider) => provider.catalog);
    const fingerprint = newestCatalogReviewedAt(catalogs);
    const result = await discover(catalogs, credentialResolver);
    const fetchedAt = new Date().toISOString();
    if (result.providersConfigured === 0) {
      if (operationGeneration === generation) {
        // A credential-less replacement must still own the final persisted
        // state. ModelsStore serializes this clear behind any save that the
        // displaced operation already queued.
        await store.clear();
      }
      return withStaticModels(
        {
          models: [],
          source: 'bootstrap',
          errors: {},
          fetchedAt,
          supportedModelsReviewedAt: fingerprint,
        },
        providerConfigs,
      );
    }
    if (operationGeneration === generation) {
      await store.save(result.models, fingerprint);
    }
    return withStaticModels(
      {
        models: result.models,
        source: 'live',
        errors: result.errors,
        fetchedAt,
        supportedModelsReviewedAt: fingerprint,
      },
      providerConfigs,
    );
  }

  const controller: ModelsRouteController = {
    get() {
      if (inFlight) return inFlight;
      return track(async (operationGeneration) => {
        const providerConfigs = options.getProviderConfigs();
        const fingerprint = newestCatalogReviewedAt(
          providerConfigs.map((provider) => provider.catalog),
        );
        const stored = await store.load(fingerprint);
        if (operationGeneration !== generation) return controller.get();
        if (stored && stored.models.length > 0) {
          return withStaticModels(
            {
              models: stored.models,
              source: 'live',
              errors: {},
              fetchedAt: stored.fetchedAt,
              supportedModelsReviewedAt: stored.supportedModelsReviewedAt,
            },
            providerConfigs,
          );
        }
        return discoverAndRender(providerConfigs, operationGeneration);
      });
    },

    refresh() {
      // Preserve the legacy force-fresh behavior: do not join work that began
      // before the explicit refresh request.
      inFlight = null;
      return track((operationGeneration) =>
        discoverAndRender(options.getProviderConfigs(), operationGeneration),
      );
    },

    async debug() {
      const response = await controller.get();
      const credentials = await credentialStore.readProviderApiKeys();
      const providerConfigs = options.getProviderConfigs();
      const catalogs = providerConfigs.map((provider) => provider.catalog);
      return {
        ...response,
        bootstrap: expandPluginModelsForRoute(providerConfigs),
        patterns: catalogs.flatMap((catalog) =>
          (catalog.supportedPatterns ?? []).map((pattern) => ({
            provider: catalog.id,
            pattern: pattern.pattern,
            tier: pattern.tier,
          })),
        ),
        providersConfigured: Object.keys(credentials),
        providersAvailable: catalogs.map((catalog) => catalog.id),
      };
    },
  };

  return controller;
}

/** Mount a legacy or strict read-only HTTP view over a models controller. */
export function createModelsRoute(options: ModelsRouteOptions): Hono {
  const app = new Hono();
  const controller = options.controller ?? createModelsController(options);

  app.get('/', async (c) => {
    if (options.strictReadOnly && new URL(c.req.url).searchParams.size > 0) {
      return c.json(
        { code: 'validation_failed', error: 'Unknown models query parameter', retryable: false },
        400,
      );
    }
    if (c.req.query('debug') === 'true') {
      return c.json(await controller.debug());
    }
    return c.json(await controller.get());
  });

  if (!options.strictReadOnly) {
    app.post('/refresh', async (c) => {
      return c.json(await controller.refresh());
    });
  }

  return app;
}
