/**
 * A model returned directly from a provider's /models endpoint, before
 * curation/filtering. Always carries its provider id so downstream
 * consumers can group/filter without losing context.
 */
export interface RawModel {
  /** Stable provider id (e.g. "anthropic", "openai", "google") */
  provider: string;
  /** Provider-specific model id (e.g. "claude-opus-4-5") */
  id: string;
  /** Display name; falls back to id when the provider doesn't expose one */
  label: string;
}

/**
 * A curated model that has passed the `SUPPORTED_MODELS` filter and is
 * ready to display in MC. Same shape as the historical `CachedModel` for
 * compatibility with existing consumers.
 */
export interface FilteredModel {
  /** Fully-qualified `provider/model-id` value */
  value: string;
  /** Display name */
  label: string;
  /** Provider id */
  provider: string;
}

/**
 * Response shape from the gateway's `GET /models` and
 * `POST /models/refresh` endpoints. `source` distinguishes between live
 * provider data and the bootstrap fallback returned when no credentials
 * are configured.
 */
export interface ModelsResponse {
  models: FilteredModel[];
  source: 'live' | 'bootstrap';
  /** Per-provider error map. Empty in the happy path. */
  errors: Record<string, string>;
  /** ISO timestamp the data was fetched. For bootstrap, this is the build time. */
  fetchedAt: string;
  /** `MODELS_REVIEWED_AT` value at the time of fetch — used for stale detection. */
  supportedModelsReviewedAt: string;
}

/**
 * Structured error thrown by provider fetchers. Carries the HTTP status
 * code and the provider id so the gateway route can surface per-provider
 * failures without losing context.
 */
export class FetcherError extends Error {
  constructor(
    public readonly provider: string,
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'FetcherError';
  }
}
