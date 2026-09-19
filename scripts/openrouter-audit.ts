import type { CatalogModel, ProviderCatalog } from '@dash/plugin-sdk';
import { findCatalogPattern, globToRegex } from '@dash/plugins';

/** Reviewed product families, with separate premium/fast/coding lanes. These are
 * candidate-selection rules, NOT runtime globs. New brands/naming schemes need
 * review. Within a lane, OpenRouter's publication time chooses the latest
 * listing; neither date nor version is a benchmark or a quality claim. */
// Advance only after reviewing the full unfamiliar-family report, not on apply.
// Existing out-of-policy models remain visible in reviewCandidates.
export const OPENROUTER_FAMILY_REVIEWED_AT = '2026-09-13T09:00:00Z';

export const OPENROUTER_FRONTIER_FAMILIES = [
  ['OpenAI Astra', /^openai\/gpt-[\d.]+-astra$/],
  ['OpenAI Astra Pro', /^openai\/gpt-[\d.]+-astra-pro$/],
  ['OpenAI Sol', /^openai\/gpt-[\d.]+-sol$/],
  ['OpenAI Sol Pro', /^openai\/gpt-[\d.]+-sol-pro$/],
  ['OpenAI Terra', /^openai\/gpt-[\d.]+-terra$/],
  ['OpenAI Terra Pro', /^openai\/gpt-[\d.]+-terra-pro$/],
  ['OpenAI Luna', /^openai\/gpt-[\d.]+-luna$/],
  ['OpenAI Luna Pro', /^openai\/gpt-[\d.]+-luna-pro$/],
  ['OpenAI GPT', /^openai\/gpt-[\d.]+$/],
  ['OpenAI GPT Pro', /^openai\/gpt-[\d.]+-pro$/],
  ['Claude Opus', /^anthropic\/claude-opus-[\d.]+$/],
  ['Claude Sonnet', /^anthropic\/claude-sonnet-[\d.]+$/],
  ['Claude Haiku', /^anthropic\/claude-haiku-[\d.]+$/],
  ['Claude Fable', /^anthropic\/claude-fable-[\d.]+$/],
  ['Gemini Pro', /^google\/gemini-[\d.]+-pro$/],
  ['Gemini Flash', /^google\/gemini-[\d.]+-flash$/],
  ['Gemini Flash Lite', /^google\/gemini-[\d.]+-flash-lite$/],
  ['GLM', /^z-ai\/glm-[\d.]+$/],
  ['GLM Flash', /^z-ai\/glm-[\d.]+-flash$/],
  ['Kimi', /^moonshotai\/kimi-k[\d.]+$/],
  ['Kimi Code', /^moonshotai\/kimi-k[\d.]+-code$/],
  ['DeepSeek Pro', /^deepseek\/deepseek-v[\d.]+-pro(?:-\d{4})?$/],
  ['DeepSeek Flash', /^deepseek\/deepseek-v[\d.]+-flash(?:-\d{4})?$/],
  ['Qwen Max', /^qwen\/qwen[\d.]+-max(?:-\d{4,8})?$/],
  ['Qwen Plus', /^qwen\/qwen[\d.]+-plus(?:-\d{4,8})?$/],
  ['Qwen Flash', /^qwen\/qwen[\d.]+-flash$/],
  ['Qwen Coder', /^qwen\/qwen[\d.]+-coder(?:-next)?$/],
  ['Grok', /^x-ai\/grok-[\d.]+$/],
  ['Mistral Large', /^mistralai\/mistral-large(?:-[\d.-]+)?$/],
  ['Mistral Medium', /^mistralai\/mistral-medium-[\d.-]+$/],
  ['Devstral', /^mistralai\/devstral-[\d.-]+$/],
  ['Meta Muse Spark', /^meta\/muse-spark-[\d.]+$/],
  ['Seed Code', /^bytedance-seed\/seed-[\d.-]+-code$/],
  ['Seed Turbo', /^bytedance-seed\/seed-[\d.-]+-turbo$/],
  ['Qwen Large Open', /^qwen\/qwen[\d.]+-[\d.]+t-a\d+b$/],
  ['MiniMax', /^minimax\/minimax-m[\d.]+$/],
] as const;

type Raw = Record<string, unknown>;
function object(value: unknown): Raw {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Raw) : {};
}
function finite(value: unknown, minimum: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum;
}
function price(value: unknown): number | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const parsed = Number(value) * 1_000_000;
  return Number.isFinite(parsed) && parsed >= 0 ? Number(parsed.toPrecision(12)) : undefined;
}

export interface OpenRouterAudit {
  selected: CatalogModel[];
  missing: string[];
  metadataDrift: string[];
  reviewCandidates: string[];
  newFamilyCandidates: string[];
  rejected: Array<{ id: string; reason: string }>;
  missingFamilies: string[];
  unavailableFamilies: string[];
}

export async function fetchOpenRouterSnapshot(fetchImpl: typeof fetch = fetch): Promise<unknown> {
  // Public endpoint: catalog maintenance must also work in credential-less CI.
  const response = await fetchImpl('https://openrouter.ai/api/v1/models', {
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`OpenRouter models endpoint returned ${response.status}`);
  return response.json();
}

export function auditOpenRouter(
  catalog: ProviderCatalog,
  snapshot: unknown,
  now = Date.now(),
): OpenRouterAudit {
  const root = object(snapshot);
  if (
    !Array.isArray(root.data) ||
    root.data.length === 0 ||
    object(root.links).next ||
    (root.total_count !== undefined && root.total_count !== root.data.length)
  ) {
    throw new Error('OpenRouter audit requires a non-empty, complete model snapshot');
  }
  const seen = new Set<string>();
  const eligible: Array<{ model: CatalogModel; created: number }> = [];
  const rejected: OpenRouterAudit['rejected'] = [];
  for (const entry of root.data) {
    const raw = object(entry);
    if (typeof raw.id !== 'string' || !raw.id || seen.has(raw.id)) {
      throw new Error('OpenRouter snapshot has a missing or duplicate model id');
    }
    seen.add(raw.id);
    const architecture = object(raw.architecture);
    const pricing = object(raw.pricing);
    const maxTokens = object(raw.top_provider).max_completion_tokens;
    const input = architecture.input_modalities;
    const output = architecture.output_modalities;
    const parameters = raw.supported_parameters;
    const inputCost = price(pricing.prompt);
    const outputCost = price(pricing.completion);
    let reason: string | undefined;
    if (
      raw.id.includes(':') ||
      /(?:^|[-/])(preview|experimental|exp|beta|alpha|free)(?:-|$)/i.test(raw.id)
    ) {
      reason = 'Variant or pre-release requires separate review';
    } else if (!Array.isArray(parameters) || !parameters.includes('tools')) {
      reason = 'No advertised tool calling';
    } else if (
      !Array.isArray(input) ||
      !input.includes('text') ||
      !Array.isArray(output) ||
      output.length !== 1 ||
      output[0] !== 'text'
    ) {
      reason = 'Not text-in/text-out chat supported by Dash';
    } else if (
      raw.expiration_date != null &&
      (typeof raw.expiration_date !== 'string' ||
        !Number.isFinite(Date.parse(raw.expiration_date)) ||
        Date.parse(raw.expiration_date) <= now)
    ) {
      reason = 'Expired or invalid expiration date';
    } else if (
      !finite(raw.context_length, 32_768) ||
      !finite(maxTokens, 4096) ||
      maxTokens > raw.context_length ||
      !finite(raw.created, 1) ||
      inputCost === undefined ||
      outputCost === undefined
    ) {
      reason = 'Incomplete metadata or below 32K context / 4K output policy';
    }
    if (reason) {
      rejected.push({ id: raw.id, reason });
      continue;
    }
    eligible.push({
      created: raw.created as number,
      model: {
        id: raw.id,
        name: typeof raw.name === 'string' ? raw.name : raw.id,
        contextWindow: raw.context_length as number,
        maxTokens: maxTokens as number,
        reasoning: (parameters as string[]).some(
          (p) => p === 'reasoning' || p === 'reasoning_effort',
        ),
        input: (input as string[]).includes('image') ? ['text', 'image'] : ['text'],
        cost: {
          input: inputCost as number,
          output: outputCost as number,
          cacheRead: price(pricing.input_cache_read) ?? 0,
          cacheWrite: price(pricing.input_cache_write) ?? 0,
        },
      },
    });
  }
  eligible.sort((a, b) => b.created - a.created || a.model.id.localeCompare(b.model.id));
  const selected: CatalogModel[] = [];
  const missingFamilies: string[] = [];
  for (const [family, pattern] of OPENROUTER_FRONTIER_FAMILIES) {
    const latest = eligible.find(({ model }) => pattern.test(model.id));
    if (latest) selected.push(latest.model);
    else missingFamilies.push(family);
  }
  const reviewCandidates = eligible
    .filter(
      ({ model }) =>
        !OPENROUTER_FRONTIER_FAMILIES.some(([, pattern]) => pattern.test(model.id)) &&
        !findCatalogPattern(catalog, model.id),
    )
    .map(({ model }) => model.id);
  const newFamilyCandidates = eligible
    .filter(
      ({ model, created }) =>
        reviewCandidates.includes(model.id) &&
        created * 1000 > Date.parse(OPENROUTER_FAMILY_REVIEWED_AT),
    )
    .map(({ model }) => model.id);
  const missing = selected
    .filter(
      (model) =>
        !findCatalogPattern(catalog, model.id) || !catalog.models.some((m) => m.id === model.id),
    )
    .map((m) => m.id);
  const metadataDrift = selected
    .filter((model) => {
      const existing = catalog.models.find((m) => m.id === model.id);
      return (
        existing &&
        Object.keys(model).some(
          (key) =>
            JSON.stringify(existing[key as keyof CatalogModel]) !==
            JSON.stringify(model[key as keyof CatalogModel]),
        )
      );
    })
    .map((m) => m.id);
  const unavailableFamilies = OPENROUTER_FRONTIER_FAMILIES.filter(
    ([family, pattern]) =>
      missingFamilies.includes(family) && catalog.models.some((model) => pattern.test(model.id)),
  ).map(([family]) => family);
  return {
    selected,
    missing,
    metadataDrift,
    reviewCandidates,
    newFamilyCandidates,
    rejected,
    missingFamilies,
    unavailableFamilies,
  };
}

/** Merge reviewed candidates, retaining compatibility entries and overrides.
 * No deletion is inferred from an outage, missing family or API disappearance. */
export function applyOpenRouterAudit(
  catalog: ProviderCatalog,
  report: OpenRouterAudit,
  reviewedAt: string,
): ProviderCatalog {
  if (report.newFamilyCandidates.length > 0)
    throw new Error(`New families require review: ${report.newFamilyCandidates.join(', ')}`);
  if (report.unavailableFamilies.length > 0)
    throw new Error(
      `Previously represented families unavailable: ${report.unavailableFamilies.join(', ')}`,
    );
  if (report.selected.length === 0) throw new Error('Refusing an empty OpenRouter update');
  const models = new Map(catalog.models.map((model) => [model.id, model]));
  const supportedPatterns = [...(catalog.supportedPatterns ?? [])];
  let tier = Math.max(0, ...supportedPatterns.map((p) => p.tier));
  for (const model of report.selected) {
    if ((catalog.excludedPatterns ?? []).some((pattern) => globToRegex(pattern).test(model.id))) {
      throw new Error(`Review deny-list conflict for ${model.id}`);
    }
    models.set(model.id, { ...models.get(model.id), ...model });
    if (!findCatalogPattern(catalog, model.id))
      supportedPatterns.push({ pattern: model.id, tier: ++tier });
  }
  return { ...catalog, models: [...models.values()], supportedPatterns, reviewedAt };
}
