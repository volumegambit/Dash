/**
 * Curated allow-list of models verified to work with DashSquad agents.
 *
 * Requirements for a model to be listed here:
 *   1. Supports the chat completions API
 *   2. Supports tool use / function calling
 *   3. Supports streaming responses
 *
 * Each entry is a glob pattern matched against the model ID (without the
 * provider prefix). Use `*` for wildcards. Models not matching any pattern
 * are filtered out of the UI.
 *
 * To discover new models and update this list, run:
 *   npx tsx scripts/update-models.ts
 */

export interface SupportedModelEntry {
  /** Provider ID (e.g. "anthropic", "openai", "google") */
  provider: string;
  /** Glob pattern matched against model ID (e.g. "claude-sonnet-*") */
  pattern: string;
  /**
   * Capability tier for sort order within provider group.
   * Lower = more capable / shown first. Flagship = 0.
   */
  tier: number;
}

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------
const ANTHROPIC: SupportedModelEntry[] = [
  { provider: 'anthropic', pattern: 'claude-opus-*', tier: 0 },
  { provider: 'anthropic', pattern: 'claude-sonnet-*', tier: 1 },
  { provider: 'anthropic', pattern: 'claude-haiku-*', tier: 2 },
];

// ---------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------
const OPENAI: SupportedModelEntry[] = [
  // Reasoning — o-series
  { provider: 'openai', pattern: 'o3-pro', tier: 0 },
  { provider: 'openai', pattern: 'o3', tier: 1 },
  { provider: 'openai', pattern: 'o3-mini', tier: 2 },
  { provider: 'openai', pattern: 'o1-pro', tier: 3 },
  { provider: 'openai', pattern: 'o1', tier: 4 },
  { provider: 'openai', pattern: 'o1-mini', tier: 5 },
  // GPT-5.x generation
  { provider: 'openai', pattern: 'gpt-5.4-pro', tier: 10 },
  { provider: 'openai', pattern: 'gpt-5.4', tier: 11 },
  { provider: 'openai', pattern: 'gpt-5.4-mini', tier: 12 },
  { provider: 'openai', pattern: 'gpt-5.3', tier: 13 },
  { provider: 'openai', pattern: 'gpt-5.3-mini', tier: 14 },
  { provider: 'openai', pattern: 'gpt-5.2', tier: 15 },
  { provider: 'openai', pattern: 'gpt-5.1', tier: 16 },
  { provider: 'openai', pattern: 'gpt-5.1-mini', tier: 17 },
  { provider: 'openai', pattern: 'gpt-5', tier: 18 },
  { provider: 'openai', pattern: 'gpt-5-pro', tier: 18 },
  { provider: 'openai', pattern: 'gpt-5-mini', tier: 19 },
  // GPT-4.x generation
  { provider: 'openai', pattern: 'gpt-4.1', tier: 20 },
  { provider: 'openai', pattern: 'gpt-4.1-mini', tier: 21 },
  { provider: 'openai', pattern: 'gpt-4o', tier: 22 },
  { provider: 'openai', pattern: 'gpt-4o-mini', tier: 23 },
  { provider: 'openai', pattern: 'gpt-4-turbo', tier: 24 },
  { provider: 'openai', pattern: 'gpt-4', tier: 25 },
  // Legacy
  { provider: 'openai', pattern: 'gpt-3.5-turbo', tier: 30 },
];

// ---------------------------------------------------------------------------
// Google
// ---------------------------------------------------------------------------
const GOOGLE: SupportedModelEntry[] = [
  { provider: 'google', pattern: 'gemini-*-pro*', tier: 0 },
  { provider: 'google', pattern: 'gemini-*-flash*', tier: 1 },
  { provider: 'google', pattern: 'gemini-pro*', tier: 2 },
  { provider: 'google', pattern: 'gemini-*', tier: 3 },
];

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
export const SUPPORTED_MODELS: SupportedModelEntry[] = [
  ...ANTHROPIC,
  ...OPENAI,
  ...GOOGLE,
];

/**
 * Convert a glob pattern (with `*` wildcards) to a RegExp.
 * The pattern must match the full model ID.
 */
export function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

/**
 * Check if a model ID is supported for the given provider.
 * Returns the matching entry (with tier info) or null.
 */
export function findSupportedModel(
  provider: string,
  modelId: string,
): SupportedModelEntry | null {
  for (const entry of SUPPORTED_MODELS) {
    if (entry.provider !== provider) continue;
    if (globToRegex(entry.pattern).test(modelId)) return entry;
  }
  return null;
}

/**
 * Check if a model ID is in the allow-list.
 */
export function isModelSupported(provider: string, modelId: string): boolean {
  return findSupportedModel(provider, modelId) !== null;
}
