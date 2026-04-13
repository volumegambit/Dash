import { applySupportedFilter } from './filter.js';
import { PROVIDERS } from './providers/index.js';
import type { ProviderDefinition } from './providers/types.js';
import { FetcherError, type FilteredModel } from './types.js';

/**
 * Resolves a credential for a given provider, or null if none configured.
 * The gateway implementation reads from its encrypted credential store;
 * the audit script reads from .env.local at the repo root. The interface
 * stays the same so `discoverModels` is provider/source agnostic.
 */
export type CredentialResolver = (
  provider: ProviderDefinition,
) => Promise<string | null>;

export interface DiscoverResult {
  /** Filtered, curated, sorted by tier within provider */
  models: FilteredModel[];
  /** Per-provider error map. Empty in the happy path. */
  errors: Record<string, string>;
  /** Number of providers that had a credential configured */
  providersConfigured: number;
}

/**
 * Iterate every provider in the registry. For each provider with a
 * credential, fetch live models in parallel; on failure, record the
 * error and continue. Apply the `SUPPORTED_MODELS` filter to the union
 * of successful responses and return the curated list.
 *
 * Does NOT substitute the bootstrap fallback when no credentials are
 * configured — that's a route-level decision, not a discovery-level
 * one. `discoverModels` returns `models: []` in that case and the
 * caller (gateway route handler) chooses what to do.
 */
export async function discoverModels(
  resolveCredential: CredentialResolver,
): Promise<DiscoverResult> {
  const errors: Record<string, string> = {};
  let providersConfigured = 0;

  // Resolve credentials in parallel
  const credentials = await Promise.all(
    PROVIDERS.map(async (provider) => ({
      provider,
      apiKey: await resolveCredential(provider),
    })),
  );

  // Fetch from each provider that has a credential, in parallel
  const fetchResults = await Promise.all(
    credentials.map(async ({ provider, apiKey }) => {
      if (!apiKey) return { provider, models: [] };
      providersConfigured++;
      try {
        const models = await provider.fetchModels(apiKey);
        return { provider, models };
      } catch (err) {
        const message =
          err instanceof FetcherError
            ? err.message
            : err instanceof Error
              ? err.message
              : String(err);
        errors[provider.id] = message;
        return { provider, models: [] };
      }
    }),
  );

  const allRaw = fetchResults.flatMap((r) => r.models);
  const filtered = applySupportedFilter(allRaw);

  return {
    models: filtered,
    errors,
    providersConfigured,
  };
}
