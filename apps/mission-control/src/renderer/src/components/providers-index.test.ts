import type { RuntimePluginProvider } from '@dash/management';
import { describe, expect, it } from 'vitest';
import { separateProviders } from './providers-index.js';
import { PROVIDERS } from './providers.js';

describe('separateProviders', () => {
  it('maps a non-core runtime provider into the plugin list', () => {
    const runtime: RuntimePluginProvider[] = [
      { id: 'acme', label: 'Acme AI', credentialPrefix: 'ACME' },
    ];
    const { core, plugin } = separateProviders(runtime);

    expect(core).toEqual(PROVIDERS);
    expect(plugin).toHaveLength(1);
    expect(plugin[0]).toMatchObject({
      id: 'acme',
      name: 'Acme AI',
      available: true,
      credentialPrefix: 'ACME',
    });
    expect(typeof plugin[0]?.description).toBe('string');
  });

  it('filters out a runtime provider whose id collides with a core provider', () => {
    const runtime: RuntimePluginProvider[] = [
      { id: 'anthropic', label: 'Shadow Anthropic', credentialPrefix: 'SHADOW' },
      { id: 'custom', label: 'Custom', credentialPrefix: 'CUSTOM' },
    ];
    const { core, plugin } = separateProviders(runtime);

    expect(core).toEqual(PROVIDERS);
    expect(plugin.map((p) => p.id)).toEqual(['custom']);
    expect(plugin.some((p) => p.id === 'anthropic')).toBe(false);
  });

  it('returns the full static PROVIDERS as core and an empty plugin list when no runtime providers', () => {
    const { core, plugin } = separateProviders([]);
    expect(core).toEqual(PROVIDERS);
    expect(plugin).toEqual([]);
  });
});
