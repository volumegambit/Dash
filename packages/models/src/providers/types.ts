import type { RawModel } from '../types.js';

/**
 * One supported AI provider. Adding a new provider is a single new file
 * exporting one of these objects, plus an append to the `PROVIDERS` array
 * in `providers/index.ts`. Everything downstream — the gateway route, the
 * audit script, the CI freshness check — iterates this registry, so a
 * new provider is invisibly plumbed everywhere by being added once.
 */
export interface ProviderDefinition {
  /**
   * Stable id used in model values (`<id>/<modelId>`), credential store
   * keys, and `SUPPORTED_MODELS` patterns. Lowercase, no spaces.
   */
  readonly id: string;

  /** Human-readable label shown in UI and logs */
  readonly label: string;

  /**
   * Credential store key prefix matched against this provider. The
   * gateway looks for keys of the form `<credentialPrefix>:<name>`
   * (e.g. `anthropic-api-key:default`).
   */
  readonly credentialPrefix: string;

  /**
   * Fetch live models from this provider's API. Throws `FetcherError`
   * on HTTP failures (non-2xx or network errors). The caller is
   * responsible for catching and surfacing per-provider errors.
   */
  fetchModels(apiKey: string, signal?: AbortSignal): Promise<RawModel[]>;
}
