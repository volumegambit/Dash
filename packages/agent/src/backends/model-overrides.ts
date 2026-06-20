import type { Api, Model } from '@mariozechner/pi-ai';

/**
 * Stop-gap model definitions for Anthropic (and other provider) models that
 * Anthropic has released but the pinned `@mariozechner/pi-ai` build does not
 * yet carry in its generated registry.
 *
 * ## Why this exists
 *
 * Dash has two independent model gatekeepers:
 *
 *   1. The `@dash/models` allow-list (`SUPPORTED_MODELS`) decides which models
 *      the gateway *lists* in the deploy/chat dropdown. Its Anthropic patterns
 *      (`claude-opus-*`, `claude-fable-*`) match new releases, so a freshly
 *      shipped model shows up in the UI as soon as the live `/v1/models` call
 *      returns it.
 *   2. pi-ai's `getModel(provider, id)` decides which models the agent can
 *      actually *run*. It is a `Map.get()` over a static, build-time generated
 *      table (`models.generated.js`) with no public registration API.
 *
 * When Anthropic ships a model that the current pi-ai build predates, (1)
 * lets the user select it but (2) returns `undefined`, so `resolveModel()`
 * throws `Unknown model "anthropic/<id>"` and the chat fails. Bumping pi-ai
 * does not necessarily help — as of 2026-06-20 even the latest pi-ai (0.73.1)
 * has no `claude-opus-4-8` or `claude-fable-5` entry; its newest Opus is
 * `claude-opus-4-7`.
 *
 * This map closes that gap: `resolveModel()` consults pi-ai first and falls
 * back here only when pi-ai doesn't know the id.
 *
 * ## Why `reasoning: false` on these entries
 *
 * pi-ai's `supportsAdaptiveThinking()` (in its anthropic provider) recognizes
 * only `opus-4-6`/`opus-4-7`/`sonnet-4-6` by substring — it does NOT match
 * `opus-4-8` or `fable`. With `reasoning: true`, pi-ai would therefore build a
 * thinking request these models reject:
 *
 *   - With a thinking level requested, it falls back to the legacy
 *     `thinking: {type: "enabled", budget_tokens: N}` shape, which Opus 4.8
 *     and Fable 5 both 400 on (budget-based thinking was removed in 4.7+).
 *   - At Dash's default (`thinkingLevel: "off"`, which Dash never changes) it
 *     sends `thinking: {type: "disabled"}`. Opus 4.8 accepts that, but Fable 5
 *     400s on it — Fable requires the thinking param to be omitted entirely.
 *
 * Setting `reasoning: false` makes pi-ai's anthropic provider skip the thinking
 * block altogether (it is gated on `model.reasoning`). That is correct for both
 * models here: Opus 4.8 runs without extended thinking — exactly like every
 * other model in Dash, which defaults `thinkingLevel` to "off" — and Fable 5
 * thinks server-side (its thinking is always on) with the param omitted as
 * required.
 *
 * The clean future fix is pi-ai's own `compat.forceAdaptiveThinking` model
 * flag (documented at pi.dev/docs/latest/models), which would let these run
 * adaptive thinking with `reasoning: true`. It is NOT implemented in any
 * published pi-ai (verified ≤ 0.73.1), and Dash's embedded SDK path doesn't
 * read `~/.pi/agent/models.json` anyway — so it's a future lever, not an
 * option today. When pi-ai ships it (or native entries with a fixed
 * `supportsAdaptiveThinking`), flip these back to `reasoning: true`.
 *
 * ## Maintenance
 *
 * When a pi-ai upgrade adds one of these ids natively, delete the entry — the
 * pi-ai registry takes precedence and the override becomes dead weight. The
 * `model-overrides.test.ts` tripwire flags this by asserting pi-ai still
 * lacks each overridden id.
 */
const MODEL_OVERRIDES: Record<string, Record<string, Model<Api>>> = {
  anthropic: {
    // Claude Opus 4.8 — current flagship Opus. Mirrors pi-ai's
    // `claude-opus-4-7` registry entry (same api, pricing, context window),
    // except `reasoning: false` — see the file header for why.
    'claude-opus-4-8': {
      id: 'claude-opus-4-8',
      name: 'Claude Opus 4.8',
      api: 'anthropic-messages',
      provider: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      reasoning: false,
      input: ['text', 'image'],
      cost: {
        input: 5,
        output: 25,
        cacheRead: 0.5,
        cacheWrite: 6.25,
      },
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    },
    // Claude Fable 5 — Anthropic's most capable widely released model.
    // $10/$50 per MTok (cacheRead 0.1x input, cacheWrite 1.25x input),
    // 1M context, 128K output. `reasoning: false` is required, not just
    // robust: Fable rejects `thinking: {type: "disabled"}`, which pi-ai
    // would send at Dash's default thinking-off — see the file header.
    'claude-fable-5': {
      id: 'claude-fable-5',
      name: 'Claude Fable 5',
      api: 'anthropic-messages',
      provider: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      reasoning: false,
      input: ['text', 'image'],
      cost: {
        input: 10,
        output: 50,
        cacheRead: 1.0,
        cacheWrite: 12.5,
      },
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    },
  },
};

/**
 * Return a Dash-supplied `Model` for a provider/model id that the pinned
 * pi-ai build does not carry, or `undefined` if no override applies.
 *
 * Callers should prefer pi-ai's own `getModel()` and only fall back here:
 *
 * ```ts
 * const model = getModel(provider, modelId) ?? getModelOverride(provider, modelId);
 * ```
 */
export function getModelOverride(provider: string, modelId: string): Model<Api> | undefined {
  return MODEL_OVERRIDES[provider]?.[modelId];
}
