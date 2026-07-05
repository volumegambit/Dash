import type {
  CatalogAuthRule,
  CatalogEntryFilters,
  CatalogModel,
  CatalogUiHints,
  ModelsFetchSpec,
  ProviderCatalog,
  SupportedPattern,
} from '@dash/plugin-sdk';

const KEBAB_CASE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const VALID_APIS = new Set([
  'openai-completions',
  'openai-responses',
  'azure-openai-responses',
  'openai-codex-responses',
  'anthropic-messages',
  'mistral-conversations',
  'bedrock-converse-stream',
  'google-generative-ai',
  'google-vertex',
]);

/** Keep a recognized string field, or `undefined`. */
function optString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** Keep a recognized boolean field, or `undefined`. */
function optBool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}

/**
 * Reconstructs a `CatalogModel['input']` array if every entry is a recognized
 * modality, otherwise `undefined`. Field-by-field (no spread) for proto-safety.
 */
function optInput(v: unknown): ('text' | 'image')[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: ('text' | 'image')[] = [];
  for (const x of v) {
    if (x === 'text' || x === 'image') out.push(x);
    else return undefined;
  }
  return out;
}

/**
 * Reconstructs a `CatalogModel['cost']` object if all four fields are numbers,
 * otherwise `undefined`. Built field-by-field (no spread).
 */
function optCost(v: unknown): CatalogModel['cost'] {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  const c = v as Record<string, unknown>;
  if (
    typeof c.input !== 'number' ||
    typeof c.output !== 'number' ||
    typeof c.cacheRead !== 'number' ||
    typeof c.cacheWrite !== 'number'
  ) {
    return undefined;
  }
  return { input: c.input, output: c.output, cacheRead: c.cacheRead, cacheWrite: c.cacheWrite };
}

/**
 * Reconstructs a string→string record (skipping the `__proto__` key and any
 * non-string value), or `undefined` if `v` is not a plain object. Built on a
 * null-prototype object then shallow-copied to a plain object (proto-safe).
 */
function optStringRecord(v: unknown): Record<string, string> | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  const src = v as Record<string, unknown>;
  const out: Record<string, string> = Object.create(null);
  for (const [k, val] of Object.entries(src)) {
    if (k === '__proto__') continue;
    if (typeof val === 'string') out[k] = val;
  }
  return { ...out };
}

/**
 * Reconstructs an arbitrary string→unknown record (skipping `__proto__`), or
 * `undefined` if `v` is not a plain object. Used for `compat` pass-through.
 */
function optUnknownRecord(v: unknown): Record<string, unknown> | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  const src = v as Record<string, unknown>;
  const out: Record<string, unknown> = Object.create(null);
  for (const [k, val] of Object.entries(src)) {
    if (k === '__proto__') continue;
    out[k] = val;
  }
  return { ...out };
}

/**
 * Reconstructs a `dynamicModelDefaults` object if both fields are numbers,
 * otherwise `undefined`.
 */
function optModelDefaults(v: unknown): ProviderCatalog['dynamicModelDefaults'] {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  const d = v as Record<string, unknown>;
  if (typeof d.contextWindow !== 'number' || typeof d.maxTokens !== 'number') return undefined;
  return { contextWindow: d.contextWindow, maxTokens: d.maxTokens };
}

/**
 * Validates a single catalog model. Required: string `id`, number
 * `contextWindow`, number `maxTokens`. Optional fields are validated when
 * present and dropped when malformed. Built field-by-field (no raw spread —
 * proto-safe, consistent with `manifest.ts` / `hooks-manifest.ts`).
 */
function validateModel(v: unknown, where: string): CatalogModel {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new Error(`${where}: model must be an object`);
  }
  const m = v as Record<string, unknown>;
  if (typeof m.id !== 'string' || m.id.length === 0) {
    throw new Error(`${where}: model 'id' must be a non-empty string`);
  }
  if (typeof m.contextWindow !== 'number') {
    throw new Error(`${where}: model 'contextWindow' must be a number`);
  }
  if (typeof m.maxTokens !== 'number') {
    throw new Error(`${where}: model 'maxTokens' must be a number`);
  }
  const name = optString(m.name);
  const reasoning = optBool(m.reasoning);
  const input = optInput(m.input);
  const cost = optCost(m.cost);
  const headers = optStringRecord(m.headers);
  const compat = optUnknownRecord(m.compat);
  return {
    id: m.id,
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
    ...(name !== undefined ? { name } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(input !== undefined ? { input } : {}),
    ...(cost !== undefined ? { cost } : {}),
    ...(headers !== undefined ? { headers } : {}),
    ...(compat !== undefined ? { compat } : {}),
  };
}

function validateAuthRule(v: unknown, where: string): CatalogAuthRule {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new Error(`${where}: auth rule must be an object`);
  }
  const r = v as Record<string, unknown>;
  const whenKeyPrefix = optString(r.whenKeyPrefix);
  const header = optString(r.header);
  const valuePrefix = optString(r.valuePrefix);
  const queryParam = optString(r.queryParam);
  const extraHeaders = optStringRecord(r.extraHeaders);
  if (header !== undefined && queryParam !== undefined) {
    throw new Error(`${where}: auth rule must use header or queryParam, not both`);
  }
  if (header === undefined && queryParam === undefined) {
    throw new Error(`${where}: auth rule needs a header or a queryParam`);
  }
  return {
    ...(whenKeyPrefix !== undefined ? { whenKeyPrefix } : {}),
    ...(header !== undefined ? { header } : {}),
    ...(valuePrefix !== undefined ? { valuePrefix } : {}),
    ...(queryParam !== undefined ? { queryParam } : {}),
    ...(extraHeaders !== undefined ? { extraHeaders } : {}),
  };
}

/**
 * Validates a `CatalogEntryFilters` block (declarative post-fetch filtering).
 * `arrayIncludes` entries need non-empty string `path` + `value`;
 * `excludeIdSubstrings` entries must be non-empty strings. Built field-by-field
 * (proto-safe), throwing per bad field.
 */
function validateEntryFilters(v: unknown, where: string): CatalogEntryFilters {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new Error(`${where}: entryFilters must be an object`);
  }
  const e = v as Record<string, unknown>;
  let arrayIncludes: { path: string; value: string }[] | undefined;
  if (e.arrayIncludes !== undefined) {
    if (!Array.isArray(e.arrayIncludes)) {
      throw new Error(`${where}: entryFilters 'arrayIncludes' must be an array`);
    }
    arrayIncludes = e.arrayIncludes.map((r, i) => {
      if (typeof r !== 'object' || r === null || Array.isArray(r)) {
        throw new Error(`${where}: entryFilters arrayIncludes[${i}] must be an object`);
      }
      const rule = r as Record<string, unknown>;
      if (typeof rule.path !== 'string' || rule.path.length === 0) {
        throw new Error(
          `${where}: entryFilters arrayIncludes[${i}] 'path' must be a non-empty string`,
        );
      }
      if (typeof rule.value !== 'string' || rule.value.length === 0) {
        throw new Error(
          `${where}: entryFilters arrayIncludes[${i}] 'value' must be a non-empty string`,
        );
      }
      return { path: rule.path, value: rule.value };
    });
  }
  let excludeIdSubstrings: string[] | undefined;
  if (e.excludeIdSubstrings !== undefined) {
    if (!Array.isArray(e.excludeIdSubstrings)) {
      throw new Error(`${where}: entryFilters 'excludeIdSubstrings' must be an array`);
    }
    excludeIdSubstrings = e.excludeIdSubstrings.map((s, i) => {
      if (typeof s !== 'string' || s.length === 0) {
        throw new Error(
          `${where}: entryFilters excludeIdSubstrings[${i}] must be a non-empty string`,
        );
      }
      return s;
    });
  }
  return {
    ...(arrayIncludes !== undefined ? { arrayIncludes } : {}),
    ...(excludeIdSubstrings !== undefined ? { excludeIdSubstrings } : {}),
  };
}

function validateModelsFetch(v: unknown, where: string): ModelsFetchSpec {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new Error(`${where}: modelsFetch must be an object`);
  }
  const f = v as Record<string, unknown>;
  const whenKeyPrefix = optString(f.whenKeyPrefix);
  if (typeof f.url !== 'string' || f.url.length === 0) {
    throw new Error(`${where}: modelsFetch 'url' must be a non-empty string`);
  }
  if (!Array.isArray(f.auth)) {
    throw new Error(`${where}: modelsFetch 'auth' must be an array of auth rules`);
  }
  const auth = f.auth.map((r, i) => validateAuthRule(r, `${where}.auth[${i}]`));
  if (typeof f.listPath !== 'string' || f.listPath.length === 0) {
    throw new Error(`${where}: modelsFetch 'listPath' must be a non-empty string`);
  }
  if (typeof f.idPath !== 'string' || f.idPath.length === 0) {
    throw new Error(`${where}: modelsFetch 'idPath' must be a non-empty string`);
  }
  const namePath = optString(f.namePath);
  const stripIdPrefix = optString(f.stripIdPrefix);
  const entryFilters =
    f.entryFilters !== undefined ? validateEntryFilters(f.entryFilters, `${where}`) : undefined;
  return {
    ...(whenKeyPrefix !== undefined ? { whenKeyPrefix } : {}),
    url: f.url,
    auth,
    listPath: f.listPath,
    idPath: f.idPath,
    ...(namePath !== undefined ? { namePath } : {}),
    ...(stripIdPrefix !== undefined ? { stripIdPrefix } : {}),
    ...(entryFilters !== undefined ? { entryFilters } : {}),
  };
}

function validateSupportedPatterns(v: unknown, where: string): SupportedPattern[] {
  if (!Array.isArray(v)) throw new Error(`${where}: supportedPatterns must be an array`);
  return v.map((p, i) => {
    if (typeof p !== 'object' || p === null || Array.isArray(p)) {
      throw new Error(`${where}[${i}]: pattern entry must be an object`);
    }
    const e = p as Record<string, unknown>;
    if (typeof e.pattern !== 'string' || e.pattern.length === 0) {
      throw new Error(`${where}[${i}]: 'pattern' must be a non-empty string`);
    }
    if (typeof e.tier !== 'number') {
      throw new Error(`${where}[${i}]: 'tier' must be a number`);
    }
    return { pattern: e.pattern, tier: e.tier };
  });
}

function optUiHints(v: unknown): CatalogUiHints | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  const u = v as Record<string, unknown>;
  const keyConsoleUrl = optString(u.keyConsoleUrl);
  const keyPlaceholder = optString(u.keyPlaceholder);
  const docsUrl = optString(u.docsUrl);
  if (keyConsoleUrl === undefined && keyPlaceholder === undefined && docsUrl === undefined) {
    return undefined;
  }
  return {
    ...(keyConsoleUrl !== undefined ? { keyConsoleUrl } : {}),
    ...(keyPlaceholder !== undefined ? { keyPlaceholder } : {}),
    ...(docsUrl !== undefined ? { docsUrl } : {}),
  };
}

/**
 * Validates a parsed provider-catalog JSON object against Dash semantics:
 * kebab-case `id`, string `label`/`credentialPrefix`/`baseUrl`, `api` ∈
 * {`openai-completions`, `anthropic-messages`}, and a NON-EMPTY `models` array
 * whose entries each carry a string `id` + number `contextWindow`/`maxTokens`.
 * Optional fields (`dynamicModels`, `dynamicModelDefaults`, `placeholderKey`,
 * and per-model metadata) are validated when present and dropped when
 * malformed. Built field-by-field (never returns/spreads the parsed object →
 * prototype-pollution-safe, consistent with `manifest.ts`). Throws a clear
 * error per bad field so the loader can isolate the offending plugin.
 */
export function validateProviderCatalog(raw: unknown): ProviderCatalog {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('provider catalog must be a JSON object');
  }
  const c = raw as Record<string, unknown>;
  if (typeof c.id !== 'string' || !KEBAB_CASE.test(c.id)) {
    throw new Error(`provider catalog 'id' must be kebab-case, got '${String(c.id)}'`);
  }
  if (typeof c.label !== 'string' || c.label.length === 0) {
    throw new Error("provider catalog 'label' must be a non-empty string");
  }
  if (typeof c.credentialPrefix !== 'string' || c.credentialPrefix.length === 0) {
    throw new Error("provider catalog 'credentialPrefix' must be a non-empty string");
  }
  // At runtime the provider's API key is always looked up by `id` (the gateway
  // extracts the prefix-before-`-api-key` from stored keys and pi-ai attaches
  // auth keyed by `model.provider` === `id`; placeholder-key injection also uses
  // `id`). So `credentialPrefix` is effectively required to equal
  // `${id}-api-key` — otherwise the stored key silently never attaches and the
  // provider can't authenticate, with no error. Enforce it here.
  if (c.credentialPrefix !== `${c.id}-api-key`) {
    throw new Error(
      `provider catalog "${c.id}": credentialPrefix must be "${c.id}-api-key" (got "${c.credentialPrefix}")`,
    );
  }
  if (typeof c.baseUrl !== 'string' || c.baseUrl.length === 0) {
    throw new Error("provider catalog 'baseUrl' must be a non-empty string");
  }
  if (typeof c.api !== 'string' || !VALID_APIS.has(c.api)) {
    throw new Error("provider catalog 'api' must be one of pi-ai's known API shapes");
  }
  if (!Array.isArray(c.models)) {
    throw new Error("provider catalog 'models' must be an array");
  }
  if (c.models.length === 0) {
    throw new Error("provider catalog 'models' must be a non-empty array");
  }
  const models = c.models.map((m, i) => validateModel(m, `models[${i}]`));

  const dynamicModels = optBool(c.dynamicModels);
  const dynamicModelDefaults = optModelDefaults(c.dynamicModelDefaults);
  const placeholderKey = optString(c.placeholderKey);

  const modelsFetch =
    c.modelsFetch !== undefined
      ? Array.isArray(c.modelsFetch)
        ? c.modelsFetch.map((v, i) => validateModelsFetch(v, `catalog "${c.id}" modelsFetch[${i}]`))
        : validateModelsFetch(c.modelsFetch, `catalog "${c.id}"`)
      : undefined;
  const supportedPatterns =
    c.supportedPatterns !== undefined
      ? validateSupportedPatterns(c.supportedPatterns, `catalog "${c.id}" supportedPatterns`)
      : undefined;
  let reviewedAt: string | undefined;
  if (c.reviewedAt !== undefined) {
    if (typeof c.reviewedAt !== 'string' || !ISO_DATE.test(c.reviewedAt)) {
      throw new Error(`catalog "${c.id}": reviewedAt must be an ISO date (YYYY-MM-DD)`);
    }
    reviewedAt = c.reviewedAt;
  }
  const ui = optUiHints(c.ui);

  return {
    id: c.id,
    label: c.label,
    credentialPrefix: c.credentialPrefix,
    baseUrl: c.baseUrl,
    api: c.api as ProviderCatalog['api'],
    models,
    ...(dynamicModels !== undefined ? { dynamicModels } : {}),
    ...(dynamicModelDefaults !== undefined ? { dynamicModelDefaults } : {}),
    ...(placeholderKey !== undefined ? { placeholderKey } : {}),
    ...(modelsFetch !== undefined ? { modelsFetch } : {}),
    ...(supportedPatterns !== undefined ? { supportedPatterns } : {}),
    ...(reviewedAt !== undefined ? { reviewedAt } : {}),
    ...(ui !== undefined ? { ui } : {}),
  };
}
