import type { CatalogModel, ProviderCatalog } from '@dash/plugin-sdk';

const KEBAB_CASE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const VALID_APIS = new Set(['openai-completions', 'anthropic-messages']);

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
    throw new Error("provider catalog 'api' must be 'openai-completions' or 'anthropic-messages'");
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
  };
}
