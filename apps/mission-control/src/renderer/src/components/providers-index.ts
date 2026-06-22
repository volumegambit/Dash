import type { RuntimePluginProvider } from '@dash/management';
import { PROVIDERS, type Provider, type ProviderOption } from './providers.js';

/**
 * A plugin-contributed provider, shaped for the AI Providers UI. Unlike
 * {@link ProviderOption}, `id` is a free-form string (the runtime provider id),
 * not the core {@link Provider} union.
 */
export interface PluginProviderOption {
  id: string;
  name: string;
  description?: string;
  available: boolean;
  credentialPrefix: string;
}

/**
 * Either a static core provider or a plugin-contributed one. Used by the AI
 * Providers UI, which renders both kinds in a single list.
 *
 * Lives here (not in `providers.ts`) so {@link isPluginProvider} can reference
 * {@link PluginProviderOption} without `providers.ts` importing back from this
 * module — that would create an import cycle.
 */
export type AllProviderOption = ProviderOption | PluginProviderOption;

const CORE_PROVIDER_IDS = new Set<string>(PROVIDERS.map((p) => p.id));

/**
 * Narrow an {@link AllProviderOption} to a {@link PluginProviderOption}: true
 * when the option's id is NOT one of the core {@link Provider} ids.
 */
export function isPluginProvider(p: AllProviderOption): p is PluginProviderOption {
  return !CORE_PROVIDER_IDS.has(p.id);
}

/**
 * Split the gateway's runtime providers into the static core providers and the
 * plugin-contributed ones.
 *
 * `core` is always the static {@link PROVIDERS} list. `plugin` is the runtime
 * providers whose `id` is NOT a core provider id, mapped to
 * {@link PluginProviderOption}. The server already excludes core-id collisions,
 * but we filter defensively here so a misbehaving plugin can never shadow a
 * built-in provider in the UI.
 */
export function separateProviders(runtimeProviders: RuntimePluginProvider[]): {
  core: ProviderOption[];
  plugin: PluginProviderOption[];
} {
  const plugin: PluginProviderOption[] = runtimeProviders
    .filter((p) => !CORE_PROVIDER_IDS.has(p.id))
    .map((p) => ({
      id: p.id,
      name: p.label,
      description: 'Plugin provider',
      available: true,
      credentialPrefix: p.credentialPrefix,
    }));

  return { core: PROVIDERS, plugin };
}

export type { Provider, ProviderOption };
