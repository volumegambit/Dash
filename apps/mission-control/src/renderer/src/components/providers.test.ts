import type { RuntimePluginProvider } from '@dash/management';
import { describe, expect, it } from 'vitest';
import { providerConnectConfig, sortProviders } from './providers.js';

function provider(overrides: Partial<RuntimePluginProvider>): RuntimePluginProvider {
  return {
    id: 'x',
    label: 'X',
    credentialPrefix: 'x-api-key',
    pluginName: 'dash-core-providers',
    ...overrides,
  };
}

describe('sortProviders', () => {
  it('orders by ui.sortOrder ascending, then id', () => {
    const input: RuntimePluginProvider[] = [
      provider({ id: 'zeta', label: 'Zeta', ui: { sortOrder: 2 } }),
      provider({ id: 'alpha', label: 'Alpha', ui: { sortOrder: 0 } }),
      provider({ id: 'beta', label: 'Beta', ui: { sortOrder: 1 } }),
    ];
    expect(sortProviders(input).map((p) => p.id)).toEqual(['alpha', 'beta', 'zeta']);
  });

  it('places providers with a missing sortOrder last, then sorts by id', () => {
    const input: RuntimePluginProvider[] = [
      provider({ id: 'nohint-b', label: 'No Hint B' }),
      provider({ id: 'ranked', label: 'Ranked', ui: { sortOrder: 5 } }),
      provider({ id: 'nohint-a', label: 'No Hint A' }),
    ];
    expect(sortProviders(input).map((p) => p.id)).toEqual(['ranked', 'nohint-a', 'nohint-b']);
  });

  it('breaks ties on equal sortOrder by id', () => {
    const input: RuntimePluginProvider[] = [
      provider({ id: 'c', ui: { sortOrder: 1 } }),
      provider({ id: 'a', ui: { sortOrder: 1 } }),
      provider({ id: 'b', ui: { sortOrder: 1 } }),
    ];
    expect(sortProviders(input).map((p) => p.id)).toEqual(['a', 'b', 'c']);
  });

  it('does not mutate its input', () => {
    const input: RuntimePluginProvider[] = [
      provider({ id: 'b', ui: { sortOrder: 1 } }),
      provider({ id: 'a', ui: { sortOrder: 0 } }),
    ];
    const before = input.map((p) => p.id);
    sortProviders(input);
    expect(input.map((p) => p.id)).toEqual(before);
  });
});

describe('providerConnectConfig', () => {
  it('derives the full config from ui hints', () => {
    const p = provider({
      id: 'x',
      label: 'X Labs',
      ui: {
        keyConsoleUrl: 'https://x.example/keys',
        keyPlaceholder: 'sk-x-...',
        docsUrl: 'https://x.example/docs',
      },
    });
    const config = providerConnectConfig(p);
    expect(config.title).toBe('Connect to X Labs');
    expect(config.secretKey).toBe('x-api-key:default');
    expect(config.placeholder).toBe('sk-x-...');
    expect(config.consoleUrl).toBe('');
    expect(config.apiKeysUrl).toBe('https://x.example/keys');
    expect(config.helpUrl).toBe('https://x.example/docs');
    expect(config.helpLabel).toBe('X Labs documentation');
    expect(config.explanation).toContain('X Labs');
    expect(config.steps).toHaveLength(2);
    expect(config.steps[0]).toContain('API keys page');
    expect(config.steps[1]).toContain('sk-x-...');
  });

  it('falls back to a generic paste flow when no ui hints are present', () => {
    const p = provider({ id: 'plain', label: 'Plain Provider', ui: undefined });
    const config = providerConnectConfig(p);
    expect(config.title).toBe('Connect to Plain Provider');
    expect(config.secretKey).toBe('plain-api-key:default');
    expect(config.placeholder).toBe('API key');
    expect(config.consoleUrl).toBe('');
    expect(config.apiKeysUrl).toBe('');
    expect(config.helpUrl).toBe('');
    expect(config.helpLabel).toBe('');
    expect(config.steps[0]).toContain('Plain Provider');
    expect(config.steps[1]).toBe('Paste it below.');
  });

  it('leaves helpLabel empty when docsUrl is absent', () => {
    const p = provider({
      id: 'nodoc',
      label: 'No Docs',
      ui: { keyConsoleUrl: 'https://nodoc.example/keys' },
    });
    const config = providerConnectConfig(p);
    expect(config.helpUrl).toBe('');
    expect(config.helpLabel).toBe('');
  });
});
