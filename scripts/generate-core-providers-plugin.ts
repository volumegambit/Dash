#!/usr/bin/env npx tsx
/**
 * Codegen for the bundled `dash-core-providers` plugin.
 *
 * Derives the five core provider catalogs (Anthropic, OpenAI, Google, Moonshot,
 * OpenRouter) from today's `@dash/models` data + the pinned `@earendil-works/pi-ai`
 * runtime registry, and writes them as pure-JSON `ProviderCatalog` files that the
 * gateway ships as an asset (see `apps/gateway/plugins/dash-core-providers`).
 *
 * What comes from where:
 *   - `id` / `label` / `credentialPrefix`         ← `PROVIDERS` (@dash/models)
 *   - `supportedPatterns` (pattern + tier)        ← `SUPPORTED_MODELS`, this provider's
 *                                                    entries minus the implied `provider`
 *   - `models[]` (id/name + capabilities)         ← `BOOTSTRAP_MODELS` for the provider,
 *                                                    enriched via `getModel(provider, id)`
 *   - `reviewedAt`                                ← `MODELS_REVIEWED_AT`
 *   - `baseUrl` / `api` / `modelsFetch` /
 *     `entryFilters` / `ui` / dynamic flags       ← `STATIC_SPECS` below (the facts that
 *                                                    live in the hand-written provider
 *                                                    fetchers, not in the data tables)
 *
 * Accepted simplifications (mirrored in the SDK/engine doc comments):
 *   1. OpenAI's 403-retry from the Codex endpoint back to the public endpoint is
 *      NOT reproduced — variant selection is by key shape (`whenKeyPrefix`) only.
 *   2. OpenRouter's runtime output-modality check is NOT reproduced — the
 *      `tools` capability filter + `:`-suffix drop + allow-list patterns give
 *      equivalent curation.
 *
 * Output is deterministic (stable key order, 2-space indent, trailing `\n`) so
 * future audit re-runs produce clean diffs. Run via `npm run providers:generate`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BOOTSTRAP_MODELS, MODELS_REVIEWED_AT, PROVIDERS, SUPPORTED_MODELS } from '@dash/models';
import type {
  CatalogModel,
  ModelsFetchSpec,
  ProviderCatalog,
  SupportedPattern,
} from '@dash/plugin-sdk';
import { getModel } from '@earendil-works/pi-ai';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const PLUGIN_DIR = resolve(REPO_ROOT, 'apps/gateway/plugins/dash-core-providers');

/**
 * Per-provider facts NOT derivable from the `@dash/models` data tables — they
 * live inside the hand-written provider fetchers today. Encoded here verbatim
 * from `packages/models/src/providers/*.ts`.
 */
interface StaticSpec {
  baseUrl: string;
  api: ProviderCatalog['api'];
  modelsFetch: ModelsFetchSpec | ModelsFetchSpec[];
  dynamicModels?: boolean;
  dynamicModelDefaults?: { contextWindow: number; maxTokens: number };
  ui?: ProviderCatalog['ui'];
}

const STATIC_SPECS: Record<string, StaticSpec> = {
  anthropic: {
    baseUrl: 'https://api.anthropic.com/v1',
    api: 'anthropic-messages',
    modelsFetch: {
      url: 'https://api.anthropic.com/v1/models',
      // OAuth (claude /login) tokens `sk-ant-oat…` authenticate via Bearer +
      // the oauth beta header; classic `sk-ant-api03-` keys use x-api-key.
      auth: [
        {
          whenKeyPrefix: 'sk-ant-oat',
          header: 'authorization',
          valuePrefix: 'Bearer ',
          extraHeaders: { 'anthropic-beta': 'oauth-2025-04-20' },
        },
        { header: 'x-api-key' },
      ],
      listPath: 'data',
      idPath: 'id',
      namePath: 'display_name',
    },
    ui: { keyConsoleUrl: 'https://console.anthropic.com/settings/keys' },
  },
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    api: 'openai-completions',
    // Ordered variants: a JWT (ChatGPT/Codex OAuth) key `eyJ…` hits the Codex
    // backend; any other key (classic `sk-…`) hits the public endpoint. See
    // accepted simplification #1 (no 403-retry between endpoints).
    modelsFetch: [
      {
        whenKeyPrefix: 'eyJ',
        url: 'https://chatgpt.com/backend-api/codex/models?client_version=2.0.0',
        auth: [{ header: 'authorization', valuePrefix: 'Bearer ' }],
        listPath: 'models',
        idPath: 'slug',
        namePath: 'display_name',
      },
      {
        url: 'https://api.openai.com/v1/models',
        auth: [{ header: 'authorization', valuePrefix: 'Bearer ' }],
        listPath: 'data',
        idPath: 'id',
      },
    ],
    ui: { keyConsoleUrl: 'https://platform.openai.com/api-keys' },
  },
  google: {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    api: 'google-generative-ai',
    modelsFetch: {
      url: 'https://generativelanguage.googleapis.com/v1beta/models',
      auth: [{ queryParam: 'key' }],
      listPath: 'models',
      idPath: 'name',
      namePath: 'displayName',
      stripIdPrefix: 'models/',
    },
    ui: { keyConsoleUrl: 'https://aistudio.google.com/apikey' },
  },
  moonshotai: {
    baseUrl: 'https://api.moonshot.ai/v1',
    api: 'openai-completions',
    modelsFetch: {
      url: 'https://api.moonshot.ai/v1/models',
      auth: [{ header: 'authorization', valuePrefix: 'Bearer ' }],
      listPath: 'data',
      idPath: 'id',
    },
    ui: { keyConsoleUrl: 'https://platform.moonshot.ai/console/api-keys' },
  },
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1',
    api: 'openai-completions',
    dynamicModels: true,
    dynamicModelDefaults: { contextWindow: 128000, maxTokens: 8192 },
    modelsFetch: {
      url: 'https://openrouter.ai/api/v1/models',
      // Public endpoint; a Bearer key is harmless when present.
      auth: [{ header: 'authorization', valuePrefix: 'Bearer ' }],
      listPath: 'data',
      idPath: 'id',
      namePath: 'name',
      // Capability curation (accepted simplification #2): keep tool-capable
      // models, drop the `:free`/`:nitro` variant suffixes.
      entryFilters: {
        arrayIncludes: [{ path: 'supported_parameters', value: 'tools' }],
        excludeIdSubstrings: [':'],
      },
    },
    ui: { keyConsoleUrl: 'https://openrouter.ai/keys' },
  },
};

/** Fallback capabilities when pi-ai's registry cannot resolve a bootstrap id. */
const PI_AI_UNKNOWN = { contextWindow: 200000, maxTokens: 8192 } as const;

/** Bootstrap-model id part for a provider: strip the leading `<provider>/`. */
function modelIdOf(provider: string, value: string): string {
  const prefix = `${provider}/`;
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

/** Build one `CatalogModel`, enriching from pi-ai's registry when it resolves. */
function toCatalogModel(provider: string, id: string, name: string): CatalogModel {
  const known = getModel(provider, id) as
    | {
        contextWindow?: number;
        maxTokens?: number;
        reasoning?: boolean;
        input?: ('text' | 'image')[];
        cost?: CatalogModel['cost'];
      }
    | undefined
    | null;
  const contextWindow = known?.contextWindow ?? PI_AI_UNKNOWN.contextWindow; // pi-ai-unknown fallback
  const maxTokens = known?.maxTokens ?? PI_AI_UNKNOWN.maxTokens; // pi-ai-unknown fallback
  const model: CatalogModel = { id, name, contextWindow, maxTokens };
  if (known?.reasoning !== undefined) model.reasoning = known.reasoning;
  if (Array.isArray(known?.input)) model.input = [...known.input];
  if (known?.cost) model.cost = { ...known.cost };
  return model;
}

function buildCatalog(providerId: string): ProviderCatalog {
  const def = PROVIDERS.find((p) => p.id === providerId);
  if (!def) throw new Error(`no PROVIDERS entry for "${providerId}"`);
  const spec = STATIC_SPECS[providerId];
  if (!spec) throw new Error(`no STATIC_SPECS entry for "${providerId}"`);

  const supportedPatterns: SupportedPattern[] = SUPPORTED_MODELS.filter(
    (e) => e.provider === providerId,
  ).map((e) => ({ pattern: e.pattern, tier: e.tier }));

  const models: CatalogModel[] = BOOTSTRAP_MODELS.filter((m) => m.provider === providerId).map(
    (m) => toCatalogModel(providerId, modelIdOf(providerId, m.value), m.label),
  );

  const catalog: ProviderCatalog = {
    id: def.id,
    label: def.label,
    credentialPrefix: def.credentialPrefix,
    baseUrl: spec.baseUrl,
    api: spec.api,
    models,
    ...(spec.dynamicModels !== undefined ? { dynamicModels: spec.dynamicModels } : {}),
    ...(spec.dynamicModelDefaults !== undefined
      ? { dynamicModelDefaults: spec.dynamicModelDefaults }
      : {}),
    modelsFetch: spec.modelsFetch,
    supportedPatterns,
    reviewedAt: MODELS_REVIEWED_AT,
    ...(spec.ui !== undefined ? { ui: spec.ui } : {}),
  };
  return catalog;
}

/** Root package version — the manifest version stamp used for boot-upgrade. */
function rootVersion(): string {
  const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8')) as {
    version: string;
  };
  return pkg.version;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function main(): void {
  const providersDir = resolve(PLUGIN_DIR, 'providers');
  const manifestDir = resolve(PLUGIN_DIR, '.claude-plugin');
  if (!existsSync(providersDir)) mkdirSync(providersDir, { recursive: true });
  if (!existsSync(manifestDir)) mkdirSync(manifestDir, { recursive: true });

  const manifest = {
    name: 'dash-core-providers',
    version: rootVersion(),
    description:
      "Dash's built-in LLM provider catalogs (Anthropic, OpenAI, Google, Moonshot, OpenRouter)",
  };
  writeJson(resolve(manifestDir, 'plugin.json'), manifest);

  for (const id of ['anthropic', 'openai', 'google', 'moonshotai', 'openrouter']) {
    writeJson(resolve(providersDir, `${id}.json`), buildCatalog(id));
  }

  process.stdout.write(`Wrote dash-core-providers plugin to ${PLUGIN_DIR}\n`);
}

main();
