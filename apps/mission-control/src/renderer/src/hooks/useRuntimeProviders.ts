import type { RuntimePlugin, RuntimePluginProvider } from '@dash/management';
import { useCallback, useEffect, useState } from 'react';

interface UseRuntimeProvidersResult {
  providers: RuntimePluginProvider[];
  plugins: RuntimePlugin[];
  loading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

/**
 * Hook: fetch the runtime plugin providers from the gateway via the T1 IPC
 * bridge (`window.api.plugins.runtime()` → RuntimePluginsResponse).
 *
 * Degrades gracefully: a gateway or plugin-loading failure must not break the
 * AI Providers page. On error, `error` is set and `providers`/`plugins` are
 * left as empty arrays so the page can still render the core providers.
 */
export function useRuntimeProviders(): UseRuntimeProvidersResult {
  const [providers, setProviders] = useState<RuntimePluginProvider[]>([]);
  const [plugins, setPlugins] = useState<RuntimePlugin[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const refetch = useCallback(async () => {
    setLoading(true);
    try {
      const res = await window.api.plugins.runtime();
      setProviders(res.providers);
      setPlugins(res.plugins);
      setError(null);
    } catch (err) {
      // Graceful degradation: keep the lists empty and surface the error so
      // consumers can show a non-fatal notice without losing the page.
      setProviders([]);
      setPlugins([]);
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { providers, plugins, loading, error, refetch };
}
