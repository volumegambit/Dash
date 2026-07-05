import type { CatalogAuthRule, CatalogEntryFilters, ModelsFetchSpec } from '@dash/plugin-sdk';

/** Bounded fetch: a slow provider must not wedge callers. */
const DEFAULT_TIMEOUT_MS = 10_000;

/** One live-discovered model, pre-filtering. */
export interface FetchedCatalogModel {
  id: string;
  label: string;
}

/** Carries provider + HTTP status for a failed catalog fetch. */
export class CatalogFetchError extends Error {
  override readonly name = 'CatalogFetchError';
  constructor(
    readonly provider: string,
    readonly status: number | undefined,
    message: string,
  ) {
    super(message);
  }
}

/** Walk a dot-path (`a.b.c`) through nested objects; undefined on any miss. */
function dotGet(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of path.split('.')) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** First rule whose `whenKeyPrefix` matches (unconditional rules always match). */
function pickAuthRule(rules: CatalogAuthRule[], apiKey: string): CatalogAuthRule | undefined {
  return rules.find((r) => !r.whenKeyPrefix || apiKey.startsWith(r.whenKeyPrefix));
}

/**
 * First variant whose `whenKeyPrefix` matches the stored key's shape (a spec
 * without `whenKeyPrefix` always matches, so it belongs last as the default).
 * Expresses OpenAI's JWT→Codex endpoint swap. Accepted simplification: OpenAI's
 * 403-retry from the Codex endpoint back to the public one is NOT reproduced —
 * variant selection is by key shape only.
 */
function pickVariant(specs: ModelsFetchSpec[], apiKey: string): ModelsFetchSpec | undefined {
  return specs.find((s) => !s.whenKeyPrefix || apiKey.startsWith(s.whenKeyPrefix));
}

/**
 * Applies a spec's declarative `entryFilters` to raw list entries BEFORE id
 * mapping/prefix-stripping (so `arrayIncludes` paths and `excludeIdSubstrings`
 * address the provider's own response shape). Every `arrayIncludes` rule must
 * pass (AND); a non-array at a rule's path fails the rule (entry dropped).
 */
function passesEntryFilters(entry: unknown, filters: CatalogEntryFilters, rawId: string): boolean {
  for (const rule of filters.arrayIncludes ?? []) {
    const arr = dotGet(entry, rule.path);
    if (!Array.isArray(arr) || !arr.includes(rule.value)) return false;
  }
  for (const sub of filters.excludeIdSubstrings ?? []) {
    if (rawId.includes(sub)) return false;
  }
  return true;
}

/**
 * Execute a catalog's declarative `modelsFetch` spec: authenticate per the
 * first matching auth rule, GET the endpoint, and map the response list into
 * `{id, label}` entries. Entries without a string id are skipped (a provider
 * adding new response fields must never break discovery). Throws
 * {@link CatalogFetchError} on HTTP failure or a missing/invalid list.
 */
export async function fetchCatalogModels(
  catalog: { id: string; modelsFetch?: ModelsFetchSpec | ModelsFetchSpec[] },
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<FetchedCatalogModel[]> {
  if (!catalog.modelsFetch) {
    throw new CatalogFetchError(
      catalog.id,
      undefined,
      `provider "${catalog.id}" declares no modelsFetch spec`,
    );
  }
  // Normalize to an ordered variant list, then pick the first variant whose
  // `whenKeyPrefix` matches the stored key shape (unconditional = always).
  const variants = Array.isArray(catalog.modelsFetch) ? catalog.modelsFetch : [catalog.modelsFetch];
  const spec = pickVariant(variants, apiKey);
  if (!spec) {
    throw new CatalogFetchError(
      catalog.id,
      undefined,
      'no modelsFetch variant matches the stored key shape',
    );
  }
  const url = new URL(spec.url);
  const headers: Record<string, string> = {};
  const rule = pickAuthRule(spec.auth, apiKey);
  if (rule) {
    if (rule.queryParam) url.searchParams.set(rule.queryParam, apiKey);
    if (rule.header) headers[rule.header] = `${rule.valuePrefix ?? ''}${apiKey}`;
    if (rule.extraHeaders) Object.assign(headers, rule.extraHeaders);
  }
  const res = await fetchImpl(url, {
    headers,
    signal: signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new CatalogFetchError(
      catalog.id,
      res.status,
      `${catalog.id} models endpoint returned ${res.status} ${body}`.trimEnd(),
    );
  }
  const json = (await res.json().catch(() => undefined)) as unknown;
  const list = dotGet(json, spec.listPath);
  if (!Array.isArray(list)) {
    throw new CatalogFetchError(
      catalog.id,
      res.status,
      `${catalog.id} models response has no array at "${spec.listPath}"`,
    );
  }
  const models: FetchedCatalogModel[] = [];
  for (const entry of list) {
    const rawId = dotGet(entry, spec.idPath);
    if (typeof rawId !== 'string' || rawId.length === 0) continue;
    // Declarative post-fetch filtering runs on the raw entry + raw id, before
    // any prefix strip, so filter paths address the provider's response shape.
    if (spec.entryFilters && !passesEntryFilters(entry, spec.entryFilters, rawId)) continue;
    const id =
      spec.stripIdPrefix && rawId.startsWith(spec.stripIdPrefix)
        ? rawId.slice(spec.stripIdPrefix.length)
        : rawId;
    const rawName = spec.namePath ? dotGet(entry, spec.namePath) : undefined;
    models.push({ id, label: typeof rawName === 'string' && rawName.length > 0 ? rawName : id });
  }
  return models;
}
