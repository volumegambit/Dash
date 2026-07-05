/**
 * @dash/plugin-sdk — author/host-shared types for Claude Code-compatible
 * Dash plugins. Types-heavy, near-zero runtime. No dependency on any other
 * @dash package. Grows per plan (hook payloads in Plan 3, ProviderCatalog in
 * Plan 5); Plan 1 defines only the manifest.
 *
 * The manifest is Claude Code's `.claude-plugin/plugin.json`. It is OPTIONAL
 * (name falls back to the plugin directory basename); when present, only
 * `name` is required, and unrecognized top-level fields are IGNORED so one
 * manifest can double as a Claude/Codex/Cursor manifest.
 */

export interface PluginAuthor {
  name: string;
  email?: string;
  url?: string;
}

export interface PluginManifest {
  /** kebab-case; namespaces the plugin's components. Required when a manifest exists. */
  name: string;
  /** Human-readable name for pickers; falls back to `name`. */
  displayName?: string;
  /** Semver. If omitted, the host falls back to a git SHA / 'unknown'. */
  version?: string;
  description?: string;
  author?: PluginAuthor;
  homepage?: string;
  repository?: string;
  license?: string;
  keywords?: string[];
  /**
   * Extra skill directories (each containing `<name>/SKILL.md`). Relative,
   * starting with './'. ADDS to the default `skills/` scan (never replaces it).
   */
  skills?: string[];
  /**
   * Command directories/files (`*.md`). Relative, starting with './'.
   * REPLACES the default `commands/` scan. Parsed in Plan 2.
   */
  commands?: string[];
  /**
   * Subagent directories/files (`*.md`, loadable specialists). Relative,
   * starting with './'. ADDS to the default `agents/` scan (never replaces it).
   * Parsed in Plan 4.
   */
  agents?: string[];
  /**
   * Extra provider-catalog files (`*.json`). Relative, starting with './'.
   * ADDS to the default `providers/` scan (never replaces it). Credential-bearing
   * → only honored for trusted plugins. Parsed in Plan 5.
   */
  providers?: string[];
}

/**
 * Claude Code hook lifecycle events. A plugin's `hooks/hooks.json` maps a
 * subset of these to shell commands the host runs. Unknown keys in a real
 * file are tolerated by the parser (the engine simply never fires them).
 */
export type HookEvent =
  | 'SessionStart'
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'Stop'
  | 'SubagentStart'
  | 'SubagentStop';

/** A single shell command a hook runs. `timeout` is in seconds (Claude Code semantics). */
export interface HookCommand {
  type: 'command';
  command: string;
  timeout?: number;
}

/**
 * A group of commands for an event, optionally gated by a `matcher` (e.g. a
 * tool name for PreToolUse/PostToolUse). Absent matcher → always applies.
 */
export interface HookMatcherGroup {
  matcher?: string;
  hooks: HookCommand[];
}

/** Parsed `hooks.json`: event → matcher groups. */
export type HooksConfig = Partial<Record<HookEvent, HookMatcherGroup[]>>;

/**
 * One model in a plugin-contributed provider catalog. `id`, `contextWindow`,
 * and `maxTokens` are required; everything else is optional metadata the host
 * uses for capability gating and cost display.
 */
export interface CatalogModel {
  /** Model id as sent to the provider API (the `<provider>/<model>` model segment). */
  id: string;
  /** Human-readable label; falls back to `id`. */
  name?: string;
  /** Max context window in tokens. */
  contextWindow: number;
  /** Max output tokens per response. */
  maxTokens: number;
  /** Whether the model supports extended reasoning / thinking. */
  reasoning?: boolean;
  /** Accepted input modalities. */
  input?: ('text' | 'image')[];
  /** Per-million-token cost breakdown. */
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** Extra request headers required by this model. */
  headers?: Record<string, string>;
  /** Provider-specific compatibility flags passed through verbatim. */
  compat?: Record<string, unknown>;
}

/**
 * Wire protocols the host runtime (pi-ai) can dispatch. Mirror of pi-ai's
 * `KnownApi` — keep in sync when bumping @earendil-works/pi-ai.
 */
export type CatalogApi =
  | 'openai-completions'
  | 'openai-responses'
  | 'azure-openai-responses'
  | 'openai-codex-responses'
  | 'anthropic-messages'
  | 'mistral-conversations'
  | 'bedrock-converse-stream'
  | 'google-generative-ai'
  | 'google-vertex';

/**
 * One declarative way to attach the API key to a models-list request. Rules
 * are evaluated in order; the first whose `whenKeyPrefix` matches (or that has
 * no `whenKeyPrefix`) applies. Lets a catalog express e.g. Anthropic's OAuth
 * header swap without code.
 */
export interface CatalogAuthRule {
  /** Apply this rule only when the stored key starts with this prefix. */
  whenKeyPrefix?: string;
  /** Header to carry the key (e.g. `x-api-key`, `authorization`). */
  header?: string;
  /** Prepended to the key in the header value (e.g. `Bearer `). */
  valuePrefix?: string;
  /** Carry the key as a query parameter instead of a header (e.g. Google `key`). */
  queryParam?: string;
  /** Extra literal headers sent alongside (e.g. `anthropic-beta`). */
  extraHeaders?: Record<string, string>;
}

/**
 * Declarative live model discovery: GET `url`, authenticate via the first
 * matching `auth` rule, read the array at dot-path `listPath`, and map each
 * entry's `idPath`/`namePath`. No code execution — a catalog stays pure JSON.
 */
export interface ModelsFetchSpec {
  url: string;
  /** Ordered auth rules; first match wins (see {@link CatalogAuthRule}). */
  auth: CatalogAuthRule[];
  /** Dot-path to the model array in the response (e.g. `data`, `models`). */
  listPath: string;
  /** Dot-path to the model id within a list entry (e.g. `id`, `name`). */
  idPath: string;
  /** Dot-path to a display name within a list entry. */
  namePath?: string;
  /** Strip this prefix from extracted ids (e.g. Google's `models/`). */
  stripIdPrefix?: string;
}

/** One allow-list entry: glob-style `*` wildcards, lower tier = better. */
export interface SupportedPattern {
  pattern: string;
  tier: number;
}

/** Optional rendering hints for host UIs (Mission Control). */
export interface CatalogUiHints {
  keyConsoleUrl?: string;
  keyPlaceholder?: string;
  docsUrl?: string;
}

/**
 * A plugin-contributed LLM provider catalog (one per `providers/*.json` file).
 * Credential-bearing → only trusted plugins contribute these. Adds a provider
 * the host can route to via `<id>/<model>` and look up credentials for under
 * `credentialPrefix`.
 */
export interface ProviderCatalog {
  /** kebab-case; the `<id>/<model>` provider segment + credential provider name. */
  id: string;
  /** Human-readable provider label. */
  label: string;
  /** Credential lookup prefix, e.g. `<id>-api-key`. */
  credentialPrefix: string;
  /** Provider API base URL. */
  baseUrl: string;
  /** Wire protocol the provider speaks. */
  api: CatalogApi;
  /** Non-empty list of statically-known models. */
  models: CatalogModel[];
  /** OpenRouter-style "accept any model id" — model list is advisory, not exhaustive. */
  dynamicModels?: boolean;
  /** Defaults applied to dynamically-accepted model ids (when `dynamicModels`). */
  dynamicModelDefaults?: { contextWindow: number; maxTokens: number };
  /** Keyless locals (e.g. Ollama) — placeholder key used when no credential is stored. */
  placeholderKey?: string;
  /** Declarative live model discovery; absent → static `models` only. */
  modelsFetch?: ModelsFetchSpec;
  /** Allow-list patterns filtering live-fetched models; absent → no live filter. */
  supportedPatterns?: SupportedPattern[];
  /** ISO date the model list was last human-reviewed. */
  reviewedAt?: string;
  /** Host-UI rendering hints. */
  ui?: CatalogUiHints;
}

/** Marker so the host can assert it links a compatible SDK build. */
export const PLUGIN_TYPES_VERSION = 1 as const;
