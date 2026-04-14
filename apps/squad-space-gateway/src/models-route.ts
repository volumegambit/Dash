import {
  BOOTSTRAP_MODELS,
  type CredentialResolver,
  type FilteredModel,
  MODELS_REVIEWED_AT,
  PROVIDERS,
  SUPPORTED_MODELS,
  discoverModels,
} from '@dash/models';
import { Hono } from 'hono';
import type { GatewayCredentialStore } from './credential-store.js';
import type { ModelsStore } from './models-store.js';

/**
 * Response shape returned by `GET /models` and `POST /models/refresh`.
 * Mirrors the `ModelsResponse` interface in @dash/models but defined here
 * to avoid a circular import on the lighter-weight type the route serves.
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
   * Override `discoverModels` for tests. Production callers leave this
   * unset and the route uses the real `@dash/models` orchestrator with
   * a credential resolver bound to the encrypted credential store.
   */
  discover?: typeof discoverModels;
}

/**
 * Build a Hono sub-app exposing `GET /models` and `POST /models/refresh`.
 *
 * `GET /models` reads the persisted store and returns immediately on a
 * hit. On a miss (no file, stale supportedModelsReviewedAt, or after an
 * explicit invalidation), it triggers a live fetch via `discoverModels`,
 * persists the result, and returns. When no provider credentials are
 * configured at all, returns BOOTSTRAP_MODELS without writing the store.
 *
 * `POST /models/refresh` always triggers a fresh discover. Used by MC's
 * refresh button and by callers that want to force-refetch after they
 * know credentials have changed.
 *
 * The cold-fetch path is mutex-guarded so concurrent callers share one
 * fetch instead of all racing to hit provider /v1/models endpoints.
 */
export function createModelsRoute(options: ModelsRouteOptions): Hono {
  const { store, credentialStore } = options;
  const discover = options.discover ?? discoverModels;
  const app = new Hono();

  // Promise mutex — when a refresh is in flight, all callers share it.
  let inFlight: Promise<ModelsRouteResponse> | null = null;

  /**
   * Bind a credential resolver to the encrypted store. The resolver
   * reads provider credentials lazily so the store isn't decrypted
   * until discoverModels actually wants to call a provider.
   */
  const credentialResolver: CredentialResolver = async (provider) => {
    const keys = await credentialStore.readProviderApiKeys();
    return keys[provider.id] ?? null;
  };

  async function refreshNow(): Promise<ModelsRouteResponse> {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const result = await discover(credentialResolver);
      const fetchedAt = new Date().toISOString();
      if (result.providersConfigured === 0) {
        // No credentials configured at all → return the curated bootstrap
        // list. Do NOT persist it: the store represents *live* data, and
        // the moment a credential is added the next refresh should
        // overwrite cleanly without inheriting bootstrap as a baseline.
        return {
          models: BOOTSTRAP_MODELS,
          source: 'bootstrap' as const,
          errors: {},
          fetchedAt,
          supportedModelsReviewedAt: MODELS_REVIEWED_AT,
        };
      }
      // At least one provider had a credential — persist whatever we
      // got back (could include errors for some providers).
      await store.save(result.models);
      return {
        models: result.models,
        source: 'live' as const,
        errors: result.errors,
        fetchedAt,
        supportedModelsReviewedAt: MODELS_REVIEWED_AT,
      };
    })();
    try {
      return await inFlight;
    } finally {
      inFlight = null;
    }
  }

  async function getOrRefresh(): Promise<ModelsRouteResponse> {
    const stored = await store.load();
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

  app.get('/', async (c) => {
    if (c.req.query('debug') === 'true') {
      const response = await getOrRefresh();
      const credentials = await credentialStore.readProviderApiKeys();
      const providersConfigured = Object.keys(credentials);
      const debug: ModelsDebugResponse = {
        ...response,
        bootstrap: BOOTSTRAP_MODELS,
        patterns: SUPPORTED_MODELS.map((p) => ({
          provider: p.provider,
          pattern: p.pattern,
          tier: p.tier,
        })),
        providersConfigured,
        providersAvailable: PROVIDERS.map((p) => p.id),
      };
      return c.json(debug);
    }
    return c.json(await getOrRefresh());
  });

  app.post('/refresh', async (c) => {
    // Force-fresh: clear in-flight (so a stale refresh from before a
    // credential change doesn't get joined) and run a new discover.
    inFlight = null;
    return c.json(await refreshNow());
  });

  return app;
}
