import type {
  CatalogModel,
  HookCommand,
  HookEvent,
  HookMatcherGroup,
  HooksConfig,
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

  it('HooksConfig maps hook events to matcher groups', () => {
    const cfg: HooksConfig = {
      SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }],
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'lint', timeout: 5 }] }],
    };
    expect(cfg.PreToolUse?.[0].matcher).toBe('Bash');
    expect(cfg.SessionStart?.[0].hooks[0].command).toBe('echo hi');
  });
});
