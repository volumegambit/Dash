/**
 * Curated allow-list of models verified to work with Dash agents.
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
 * To discover new models and update this list, run `/update-models` (or
 * `npm run models:audit`). The audit script bumps `MODELS_REVIEWED_AT`
 * automatically when changes are accepted.
 */

/**
 * Date this allow-list was last verified against live provider /models
 * responses. The `npm run models:check` CI gate warns at 30 days and
 * hard-fails the build at 60 days. CLAUDE.md instructs Claude to check
 * this constant at trigger points (release prep, model UI work, provider
 * SDK bumps, new providers).
 *
 * Format: YYYY-MM-DD.
 */
export const MODELS_REVIEWED_AT = '2026-06-21';

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
  // Fable is Anthropic's most capable widely released model — flagship-class
  // alongside Opus (both tier 0; Fable sorts first within the tier by id).
  { provider: 'anthropic', pattern: 'claude-fable-*', tier: 0 },
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
  // Codex variants — code-specialized GPT-5.x models exposed via the
  // ChatGPT/Codex backend. Single broad pattern (added 2026-04-13)
  // catches gpt-5-codex, gpt-5-codex-mini, gpt-5.1-codex,
  // gpt-5.1-codex-mini, gpt-5.1-codex-max, gpt-5.2-codex,
  // gpt-5.3-codex, and any future N-codex releases.
  { provider: 'openai', pattern: 'gpt-*-codex*', tier: 9 },
  // GPT-5.x generation
  { provider: 'openai', pattern: 'gpt-5.5', tier: 10 },
  { provider: 'openai', pattern: 'gpt-5.4-pro', tier: 11 },
  { provider: 'openai', pattern: 'gpt-5.4', tier: 12 },
  { provider: 'openai', pattern: 'gpt-5.4-mini', tier: 13 },
  { provider: 'openai', pattern: 'gpt-5.3', tier: 14 },
  { provider: 'openai', pattern: 'gpt-5.3-mini', tier: 15 },
  { provider: 'openai', pattern: 'gpt-5.2', tier: 16 },
  { provider: 'openai', pattern: 'gpt-5.1', tier: 17 },
  { provider: 'openai', pattern: 'gpt-5.1-mini', tier: 18 },
  { provider: 'openai', pattern: 'gpt-5', tier: 19 },
  { provider: 'openai', pattern: 'gpt-5-pro', tier: 19 },
  { provider: 'openai', pattern: 'gpt-5-mini', tier: 20 },
  // GPT-4.x generation
  { provider: 'openai', pattern: 'gpt-4.1', tier: 21 },
  { provider: 'openai', pattern: 'gpt-4.1-mini', tier: 22 },
  { provider: 'openai', pattern: 'gpt-4o', tier: 23 },
  { provider: 'openai', pattern: 'gpt-4o-mini', tier: 24 },
  { provider: 'openai', pattern: 'gpt-4-turbo', tier: 25 },
  { provider: 'openai', pattern: 'gpt-4', tier: 26 },
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
  // Gemma open-weights models (e.g. gemma-4-26b-a4b-it, gemma-4-31b-it).
  // Sort below all Gemini models; tool-use support is newer/less consistent.
  { provider: 'google', pattern: 'gemma-*', tier: 4 },
];

// ---------------------------------------------------------------------------
// Moonshot (Kimi)
// ---------------------------------------------------------------------------
// Provider id MUST be 'moonshotai' to match the pi-ai runtime + credential key.
// Restricted to the Kimi K2 family — the intersection of "in live /v1/models"
// and "resolvable by the pinned @earendil-works/pi-ai runtime" (getModel).
// Verified against a live api.moonshot.ai audit on 2026-06-21: the global
// endpoint returns the dotted ids kimi-k2.5 / kimi-k2.6 / kimi-k2.7-code /
// kimi-k2.7-code-highspeed (all pi-ai-runnable), plus moonshot-v1-* (legacy +
// vision) which pi-ai canNOT resolve and are therefore excluded. pi-ai also
// resolves dash-dated ids (kimi-k2-thinking, kimi-k2-0905-preview) not in this
// account's live list — kept allow-listed so they surface on tiers/regions that
// do expose them. Tiers order newest-version-first; reasoning flagship on top.
// Ordered specific → general (findSupportedModel returns the first match's tier).
const MOONSHOT: SupportedModelEntry[] = [
  { provider: 'moonshotai', pattern: 'kimi-k2-thinking*', tier: 0 },
  { provider: 'moonshotai', pattern: 'kimi-k2.7*', tier: 1 },
  { provider: 'moonshotai', pattern: 'kimi-k2.6', tier: 2 },
  { provider: 'moonshotai', pattern: 'kimi-k2.5', tier: 3 },
  { provider: 'moonshotai', pattern: 'kimi-k2.*', tier: 3 },
  { provider: 'moonshotai', pattern: 'kimi-k2*', tier: 4 },
];

// ---------------------------------------------------------------------------
// OpenRouter
// ---------------------------------------------------------------------------
// OpenRouter is a single OpenAI-compatible gateway fronting many vendors. It is
// its own provider group, distinct from the native Anthropic/OpenAI/Google
// providers above — choosing a model here routes it through OpenRouter (one key,
// one bill, automatic upstream failover) instead of the vendor's direct API.
//
// Patterns match the NAMESPACED id (`<vendor>/<slug>`) and use EXACT ids, not
// broad globs: the binding constraint is the pinned `@earendil-works/pi-ai`
// runtime, whose `getModel('openrouter', id)` is a registry lookup that returns
// nothing for unbundled ids — so every entry here is verified present in pi-ai
// 0.79.8's OpenRouter registry, guaranteeing it resolves at chat time. The
// `fetchModels` capability filter (tools + text-output + no `:` variant) handles
// quality gating; these patterns express family curation + sort order.
//
// Tiers order the single OpenRouter group: the frontier families Dash has no
// native provider for (DeepSeek, Qwen, Llama, Mistral, Grok, GLM) sort first;
// the big-three routed via OpenRouter sort last since they duplicate native
// providers and are usually best used directly. `:free` variants are excluded
// (rate-limited and not pi-ai-resolvable). Re-verify with `npm run
// models:audit:apply` (OPENROUTER_API_KEY set) when bumping pi-ai.
const OPENROUTER: SupportedModelEntry[] = [
  // DeepSeek
  { provider: 'openrouter', pattern: 'deepseek/deepseek-v4-pro', tier: 0 },
  { provider: 'openrouter', pattern: 'deepseek/deepseek-v4-flash', tier: 1 },
  { provider: 'openrouter', pattern: 'deepseek/deepseek-v3.2', tier: 2 },
  { provider: 'openrouter', pattern: 'deepseek/deepseek-v3.1-terminus', tier: 3 },
  { provider: 'openrouter', pattern: 'deepseek/deepseek-r1', tier: 4 },
  { provider: 'openrouter', pattern: 'deepseek/deepseek-chat', tier: 5 },
  // Qwen
  { provider: 'openrouter', pattern: 'qwen/qwen3.7-max', tier: 10 },
  { provider: 'openrouter', pattern: 'qwen/qwen3-max', tier: 11 },
  { provider: 'openrouter', pattern: 'qwen/qwen3-coder', tier: 12 },
  { provider: 'openrouter', pattern: 'qwen/qwen3-235b-a22b', tier: 13 },
  { provider: 'openrouter', pattern: 'qwen/qwen3.5-122b-a10b', tier: 14 },
  // Meta Llama
  { provider: 'openrouter', pattern: 'meta-llama/llama-4-maverick', tier: 20 },
  { provider: 'openrouter', pattern: 'meta-llama/llama-4-scout', tier: 21 },
  { provider: 'openrouter', pattern: 'meta-llama/llama-3.3-70b-instruct', tier: 22 },
  { provider: 'openrouter', pattern: 'meta-llama/llama-3.1-70b-instruct', tier: 23 },
  // Mistral
  { provider: 'openrouter', pattern: 'mistralai/mistral-large-2512', tier: 30 },
  { provider: 'openrouter', pattern: 'mistralai/mistral-medium-3.1', tier: 31 },
  { provider: 'openrouter', pattern: 'mistralai/codestral-2508', tier: 32 },
  { provider: 'openrouter', pattern: 'mistralai/devstral-2512', tier: 33 },
  // xAI (Grok)
  { provider: 'openrouter', pattern: 'x-ai/grok-4.3', tier: 40 },
  { provider: 'openrouter', pattern: 'x-ai/grok-4.20', tier: 41 },
  // Z.ai (GLM)
  { provider: 'openrouter', pattern: 'z-ai/glm-5.2', tier: 50 },
  { provider: 'openrouter', pattern: 'z-ai/glm-5', tier: 51 },
  { provider: 'openrouter', pattern: 'z-ai/glm-4.7', tier: 52 },
  { provider: 'openrouter', pattern: 'z-ai/glm-4.6', tier: 53 },
  // Anthropic via OpenRouter (duplicates native Anthropic — flagship only)
  { provider: 'openrouter', pattern: 'anthropic/claude-opus-4.8', tier: 60 },
  { provider: 'openrouter', pattern: 'anthropic/claude-sonnet-4.6', tier: 61 },
  { provider: 'openrouter', pattern: 'anthropic/claude-haiku-4.5', tier: 62 },
  { provider: 'openrouter', pattern: 'anthropic/claude-fable-5', tier: 63 },
  // OpenAI via OpenRouter (duplicates native OpenAI — flagship only)
  { provider: 'openrouter', pattern: 'openai/gpt-5.5', tier: 70 },
  { provider: 'openrouter', pattern: 'openai/gpt-5.4', tier: 71 },
  { provider: 'openrouter', pattern: 'openai/gpt-4o', tier: 72 },
  { provider: 'openrouter', pattern: 'openai/o3', tier: 73 },
  // Google via OpenRouter (duplicates native Google — flagship only)
  { provider: 'openrouter', pattern: 'google/gemini-3.5-flash', tier: 80 },
  { provider: 'openrouter', pattern: 'google/gemini-3.1-pro-preview', tier: 81 },
  { provider: 'openrouter', pattern: 'google/gemini-2.5-pro', tier: 82 },
  { provider: 'openrouter', pattern: 'google/gemini-2.5-flash', tier: 83 },
];

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
export const SUPPORTED_MODELS: SupportedModelEntry[] = [
  ...ANTHROPIC,
  ...OPENAI,
  ...GOOGLE,
  ...MOONSHOT,
  ...OPENROUTER,
];

/**
 * Memoized compiled patterns. `findSupportedModel` runs `globToRegex` for every
 * allow-list entry against every raw model on every discover; with OpenRouter's
 * large live catalog (hundreds of models) that is thousands of compilations per
 * fetch. The pattern set is small and fixed, so caching by pattern string
 * collapses all the repeated `new RegExp` work to one compile per pattern.
 */
const globRegexCache = new Map<string, RegExp>();

/**
 * Convert a glob pattern (with `*` wildcards) to a RegExp.
 * The pattern must match the full model ID.
 */
export function globToRegex(pattern: string): RegExp {
  const cached = globRegexCache.get(pattern);
  if (cached) return cached;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  const regex = new RegExp(`^${escaped}$`, 'i');
  globRegexCache.set(pattern, regex);
  return regex;
}

/**
 * Check if a model ID is supported for the given provider.
 * Returns the matching entry (with tier info) or null.
 */
export function findSupportedModel(provider: string, modelId: string): SupportedModelEntry | null {
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
