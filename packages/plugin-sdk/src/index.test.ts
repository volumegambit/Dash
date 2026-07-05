import type {
  CatalogAuthRule,
  CatalogEntryFilters,
  CatalogModel,
  FilteredModel,
  HookCommand,
  HookEvent,
  HookMatcherGroup,
  HooksConfig,
  ModelsFetchSpec,
  PluginAuthor,
  PluginManifest,
  ProviderCatalog,
} from './index.js';
import * as sdk from './index.js';

// Type-surface baseline: these names are a cross-plan contract (Plans 2–5
// import them verbatim). vitest erases types — the tuple is checked by
// `tsc --noEmit` via `npm run typecheck`.
// biome-ignore lint/suspicious/noExportsInTest: intentional — export forces tsc to check these types
export type TypeSurfaceBaseline = [
  PluginManifest,
  PluginAuthor,
  HookEvent,
  HookCommand,
  HookMatcherGroup,
  HooksConfig,
  CatalogModel,
  ProviderCatalog,
  ModelsFetchSpec,
  CatalogEntryFilters,
  FilteredModel,
];

describe('@dash/plugin-sdk surface', () => {
  it('exports exactly the expected runtime names', () => {
    expect(Object.keys(sdk).sort()).toEqual(['PLUGIN_TYPES_VERSION']);
  });

  it('PluginManifest requires only name', () => {
    const m: PluginManifest = { name: 'demo' };
    expect(m.name).toBe('demo');
  });

  it('PluginManifest accepts an optional providers field', () => {
    const m: PluginManifest = { name: 'demo', providers: ['./extra-providers'] };
    expect(m.providers).toEqual(['./extra-providers']);
  });

  it('ProviderCatalog carries id/label/api/models with optional metadata', () => {
    const cat: ProviderCatalog = {
      id: 'acme',
      label: 'Acme',
      credentialPrefix: 'acme-api-key',
      baseUrl: 'https://api.acme.test',
      api: 'openai-completions',
      models: [
        {
          id: 'acme-large',
          name: 'Acme Large',
          contextWindow: 128000,
          maxTokens: 8192,
          reasoning: true,
          input: ['text', 'image'],
          cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1.5 },
        },
      ],
      dynamicModels: true,
      dynamicModelDefaults: { contextWindow: 8000, maxTokens: 1024 },
      placeholderKey: 'local',
    };
    expect(cat.api).toBe('openai-completions');
    expect(cat.models[0].id).toBe('acme-large');
  });

  it('ProviderCatalog accepts the widened api union and the new optional blocks', () => {
    const cat: ProviderCatalog = {
      id: 'google',
      label: 'Google',
      credentialPrefix: 'google-api-key',
      baseUrl: 'https://generativelanguage.googleapis.com',
      api: 'google-generative-ai',
      models: [{ id: 'gemini-3-pro', contextWindow: 2_000_000, maxTokens: 65_536 }],
      modelsFetch: {
        url: 'https://generativelanguage.googleapis.com/v1beta/models',
        auth: [{ queryParam: 'key' }],
        listPath: 'models',
        idPath: 'name',
        namePath: 'displayName',
        stripIdPrefix: 'models/',
      },
      supportedPatterns: [{ pattern: 'gemini-*-pro*', tier: 0 }],
      reviewedAt: '2026-07-05',
      ui: { keyConsoleUrl: 'https://aistudio.google.com/apikey', keyPlaceholder: 'AIza…' },
    };
    expect(cat.api).toBe('google-generative-ai');
    expect((cat.modelsFetch as ModelsFetchSpec).auth[0]?.queryParam).toBe('key');
  });

  it('ProviderCatalog carries excludedPatterns and ui.sortOrder; FilteredModel is exported', () => {
    const cat: ProviderCatalog = {
      id: 'google',
      label: 'Google',
      credentialPrefix: 'google-api-key',
      baseUrl: 'https://generativelanguage.googleapis.com',
      api: 'google-generative-ai',
      models: [{ id: 'gemini-3-pro', contextWindow: 2_000_000, maxTokens: 65_536 }],
      supportedPatterns: [{ pattern: 'gemini-*-pro*', tier: 0 }],
      excludedPatterns: ['gemini-*-tts*'],
      ui: { keyConsoleUrl: 'https://x', sortOrder: 2 },
    };
    expect(cat.excludedPatterns).toEqual(['gemini-*-tts*']);
    expect(cat.ui?.sortOrder).toBe(2);

    const m: FilteredModel = { value: 'a/b', label: 'B', provider: 'a' };
    expect(m.value).toBe('a/b');
  });

  it('ProviderCatalog.modelsFetch accepts an ordered array of variants (whenKeyPrefix)', () => {
    const cat: ProviderCatalog = {
      id: 'openai',
      label: 'OpenAI',
      credentialPrefix: 'openai-api-key',
      baseUrl: 'https://api.openai.com/v1',
      api: 'openai-completions',
      models: [{ id: 'o3-pro', contextWindow: 200000, maxTokens: 8192 }],
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
    };
    const variants = cat.modelsFetch as ModelsFetchSpec[];
    expect(variants[0]?.whenKeyPrefix).toBe('eyJ');
    expect(variants[1]?.whenKeyPrefix).toBeUndefined();
  });

  it('ModelsFetchSpec carries declarative entryFilters (OpenRouter capability filter)', () => {
    const spec: ModelsFetchSpec = {
      url: 'https://openrouter.ai/api/v1/models',
      auth: [{ header: 'authorization', valuePrefix: 'Bearer ' }],
      listPath: 'data',
      idPath: 'id',
      namePath: 'name',
      entryFilters: {
        arrayIncludes: [{ path: 'supported_parameters', value: 'tools' }],
        excludeIdSubstrings: [':'],
      },
    };
    const filters: CatalogEntryFilters | undefined = spec.entryFilters;
    expect(filters?.arrayIncludes?.[0]?.path).toBe('supported_parameters');
    expect(filters?.excludeIdSubstrings).toEqual([':']);
  });

  it('CatalogAuthRule expresses the Anthropic OAuth header swap declaratively', () => {
    const rules: CatalogAuthRule[] = [
      {
        whenKeyPrefix: 'sk-ant-oat',
        header: 'authorization',
        valuePrefix: 'Bearer ',
        extraHeaders: { 'anthropic-beta': 'oauth-2025-04-20' },
      },
      { header: 'x-api-key' },
    ];
    expect(rules[0]?.whenKeyPrefix).toBe('sk-ant-oat');
  });

  it('HooksConfig maps hook events to matcher groups', () => {
    const cfg: HooksConfig = {
      SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }],
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'lint', timeout: 5 }] }],
    };
    expect(cfg.PreToolUse?.[0].matcher).toBe('Bash');
    expect(cfg.SessionStart?.[0].hooks[0].command).toBe('echo hi');
  });
});
