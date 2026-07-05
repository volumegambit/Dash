import type { FilteredModel, ProviderCatalog, SupportedPattern } from '@dash/plugin-sdk';
import { CatalogFetchError, fetchCatalogModels } from './catalog-fetch.js';
import { findCatalogPattern } from './catalog-filter.js';

/**
 * Resolves a credential for a given catalog id, or null if none configured. The
 * gateway implementation reads from its encrypted credential store; the audit
 * script reads from .env.local. The interface stays source-agnostic so
 * `discoverCatalogModels` is pure and gateway-free.
 */
export type CatalogCredentialResolver = (catalogId: string) => Promise<string | null>;

export interface CatalogDiscoverResult {
  /** Filtered, curated, sorted by catalog then tier then id. */
  models: FilteredModel[];
  /** Per-catalog error map keyed by catalog id. Empty in the happy path. */
  errors: Record<string, string>;
  /** Number of fetch-capable catalogs whose credential resolved. */
  providersConfigured: number;
}

/**
 * A catalog participates in live fetch iff it declares a `modelsFetch` spec AND
 * a non-empty `supportedPatterns` list (design §2.3: catalogs without patterns
 * keep static-list-only behavior). Credential resolution is checked separately.
 */
function isFetchCapable(catalog: ProviderCatalog): boolean {
  return Boolean(catalog.modelsFetch) && (catalog.supportedPatterns?.length ?? 0) > 0;
}

/** Sort key for deterministic catalog ordering: [ui.sortOrder ?? MAX, id]. */
export function catalogSortKey(catalog: ProviderCatalog): [number, string] {
  return [catalog.ui?.sortOrder ?? Number.MAX_SAFE_INTEGER, catalog.id];
}

/** Max ISO date across catalogs' `reviewedAt`; 'unreviewed' when none carry one. */
export function newestCatalogReviewedAt(
  catalogs: Array<Pick<ProviderCatalog, 'reviewedAt'>>,
): string {
  let newest: string | null = null;
  for (const { reviewedAt } of catalogs) {
    if (reviewedAt && (newest === null || reviewedAt > newest)) newest = reviewedAt;
  }
  return newest ?? 'unreviewed';
}

function compareSortKey(a: [number, string], b: [number, string]): number {
  return a[0] !== b[0] ? a[0] - b[0] : a[1].localeCompare(b[1]);
}

/**
 * Iterate every catalog. For each fetch-capable catalog with a resolved
 * credential, fetch live models in parallel; on failure, record the error under
 * the catalog id and continue. Filter fetched entries through
 * `findCatalogPattern` (deny wins over allow), then sort catalogs by
 * `catalogSortKey` and, within a catalog, by matched-pattern tier ascending then
 * id `localeCompare`. Pure — no gateway imports; the caller decides whether to
 * fall back to bootstrap when `providersConfigured` is 0.
 */
export async function discoverCatalogModels(
  catalogs: ProviderCatalog[],
  resolveCredential: CatalogCredentialResolver,
  fetchImpl: typeof fetch = fetch,
): Promise<CatalogDiscoverResult> {
  const errors: Record<string, string> = {};
  let providersConfigured = 0;

  // Resolve credentials only for fetch-capable catalogs, in parallel.
  const capable = catalogs.filter(isFetchCapable);
  const credentials = await Promise.all(
    capable.map(async (catalog) => ({
      catalog,
      apiKey: await resolveCredential(catalog.id),
    })),
  );

  // Fetch each catalog with a resolved credential, in parallel.
  type CatalogModels = {
    catalog: ProviderCatalog;
    matched: Array<{ model: FilteredModel; tier: number; id: string }>;
  };
  const results = await Promise.all(
    credentials.map(async ({ catalog, apiKey }): Promise<CatalogModels> => {
      if (!apiKey) return { catalog, matched: [] };
      providersConfigured++;
      try {
        const fetched = await fetchCatalogModels(catalog, apiKey, fetchImpl);
        const matched: CatalogModels['matched'] = [];
        for (const m of fetched) {
          const entry: SupportedPattern | null = findCatalogPattern(catalog, m.id);
          if (!entry) continue;
          matched.push({
            model: { value: `${catalog.id}/${m.id}`, label: m.label, provider: catalog.id },
            tier: entry.tier,
            id: m.id,
          });
        }
        return { catalog, matched };
      } catch (err) {
        const message =
          err instanceof CatalogFetchError
            ? err.message
            : err instanceof Error
              ? err.message
              : String(err);
        errors[catalog.id] = message;
        return { catalog, matched: [] };
      }
    }),
  );

  // Order catalogs by sort key, then within each by tier asc then id.
  results.sort((a, b) => compareSortKey(catalogSortKey(a.catalog), catalogSortKey(b.catalog)));
  const models: FilteredModel[] = [];
  for (const { matched } of results) {
    matched.sort((a, b) => (a.tier !== b.tier ? a.tier - b.tier : a.id.localeCompare(b.id)));
    for (const { model } of matched) models.push(model);
  }

  return { models, errors, providersConfigured };
}
