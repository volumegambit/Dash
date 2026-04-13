import {
  SUPPORTED_MODELS,
  type SupportedModelEntry,
  findSupportedModel,
} from './supported-models.js';
import type { FilteredModel, RawModel } from './types.js';

/**
 * Apply the curated `SUPPORTED_MODELS` allow-list to a flat list of raw
 * provider models. Returns only models matching at least one allow-list
 * pattern, sorted by tier within provider, then alphabetically by id.
 *
 * The provider order in the output is the order providers appear in
 * `SUPPORTED_MODELS` — Anthropic first, then OpenAI, then Google. This
 * keeps the gateway response deterministic so the dropdown order doesn't
 * jitter between fetches.
 */
export function applySupportedFilter(rawModels: RawModel[]): FilteredModel[] {
  type WithEntry = { raw: RawModel; entry: SupportedModelEntry; providerOrder: number };
  const matched: WithEntry[] = [];

  // Build a stable provider-order map from the SUPPORTED_MODELS entries.
  // First-seen wins; this mirrors the section ordering in supported-models.ts
  // (Anthropic, OpenAI, Google).
  const providerOrder = new Map<string, number>();
  for (const entry of SUPPORTED_MODELS) {
    if (!providerOrder.has(entry.provider)) {
      providerOrder.set(entry.provider, providerOrder.size);
    }
  }

  for (const raw of rawModels) {
    const entry = findSupportedModel(raw.provider, raw.id);
    if (!entry) continue;
    matched.push({
      raw,
      entry,
      providerOrder: providerOrder.get(raw.provider) ?? 99,
    });
  }

  matched.sort((a, b) => {
    if (a.providerOrder !== b.providerOrder) return a.providerOrder - b.providerOrder;
    if (a.entry.tier !== b.entry.tier) return a.entry.tier - b.entry.tier;
    return a.raw.id.localeCompare(b.raw.id);
  });

  return matched.map(({ raw }) => ({
    value: `${raw.provider}/${raw.id}`,
    label: raw.label,
    provider: raw.provider,
  }));
}
