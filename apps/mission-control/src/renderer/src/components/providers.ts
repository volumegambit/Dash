import type { RuntimePluginProvider } from '@dash/management';
import { providerSecretKey } from '@dash/mc/provider-keys';

/**
 * The plugin that ships Dash's built-in provider catalogs. Providers from it
 * render without a source badge; any other plugin's providers are badged with
 * their plugin name so users can tell where a provider came from.
 */
export const BUNDLED_PROVIDERS_PLUGIN = 'dash-core-providers';

/**
 * View-model consumed by ProviderConnectModal and the wizard's key step.
 * Derived per-provider from gateway data — no hardcoded provider knowledge.
 * Empty-string URL fields mean "omit that instruction step" (the modal and
 * wizard render URL steps conditionally).
 */
export interface ProviderConfig {
  title: string;
  secretKey: string;
  placeholder: string;
  consoleUrl: string;
  apiKeysUrl: string;
  helpUrl: string;
  helpLabel: string;
  explanation: string;
  steps: string[];
}

/** Sort providers for display: ui.sortOrder asc (missing last), then id. */
export function sortProviders(providers: RuntimePluginProvider[]): RuntimePluginProvider[] {
  return [...providers].sort((a, b) => {
    const ao = a.ui?.sortOrder ?? Number.MAX_SAFE_INTEGER;
    const bo = b.ui?.sortOrder ?? Number.MAX_SAFE_INTEGER;
    return ao !== bo ? ao - bo : a.id.localeCompare(b.id);
  });
}

/**
 * Derive the connect-flow copy for any provider from its catalog ui hints.
 * Works identically for bundled and third-party providers; providers without
 * hints get a generic paste-your-key flow.
 */
export function providerConnectConfig(p: RuntimePluginProvider): ProviderConfig {
  const keysUrl = p.ui?.keyConsoleUrl ?? '';
  return {
    title: `Connect to ${p.label}`,
    secretKey: providerSecretKey(p.id),
    placeholder: p.ui?.keyPlaceholder ?? 'API key',
    consoleUrl: '',
    apiKeysUrl: keysUrl,
    helpUrl: p.ui?.docsUrl ?? '',
    helpLabel: p.ui?.docsUrl ? `${p.label} documentation` : '',
    explanation: `To use ${p.label} models, your agents need an API key. It is stored encrypted on this machine and only used to talk to ${p.label}.`,
    steps: [
      keysUrl
        ? 'Create a key on the API keys page and copy it.'
        : `Create an API key in your ${p.label} account and copy it.`,
      p.ui?.keyPlaceholder
        ? `Paste it below. It looks like ${p.ui.keyPlaceholder}`
        : 'Paste it below.',
    ],
  };
}
