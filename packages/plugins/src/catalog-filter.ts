import type { ProviderCatalog, SupportedPattern } from '@dash/plugin-sdk';

/**
 * Memoized compiled patterns. A catalog's pattern set is small and fixed, but a
 * live OpenRouter fetch runs each pattern against hundreds of model ids on every
 * discover — caching by pattern string collapses the repeated `new RegExp` work
 * to one compile per pattern.
 */
const globRegexCache = new Map<string, RegExp>();

/**
 * Convert a glob pattern (with `*` wildcards) to a RegExp. Regex specials are
 * escaped so literal dots stay literal (`gpt-4.1` does NOT match `gpt-401`);
 * `*` becomes `.*`; the whole pattern is anchored `^…$` and matched
 * case-insensitively against the full model id.
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
 * Resolve which curated pattern (if any) a live-fetched model id matches, within
 * a single catalog. Exclusion wins over allow: a match against any
 * `excludedPatterns` glob short-circuits and returns null even when an allow
 * pattern also matches (serves modality filtering — Gemini TTS/image ids share
 * chat prefixes). Otherwise returns the first matching `supportedPatterns` entry
 * (pattern order encodes specificity → tier), or null on no allow match. Absent
 * pattern lists are treated as empty.
 */
export function findCatalogPattern(
  catalog: Pick<ProviderCatalog, 'supportedPatterns' | 'excludedPatterns'>,
  modelId: string,
): SupportedPattern | null {
  for (const pattern of catalog.excludedPatterns ?? []) {
    if (globToRegex(pattern).test(modelId)) return null;
  }
  for (const entry of catalog.supportedPatterns ?? []) {
    if (globToRegex(entry.pattern).test(modelId)) return entry;
  }
  return null;
}
