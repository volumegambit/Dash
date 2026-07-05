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
 * left as empty arrays. That empty-arrays-on-error contract drives the page's
 * explicit error/empty states (the error card with Retry; the wizard error
 * card) rather than falling back to any hardcoded provider list.
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
      // Graceful degradation: keep the lists empty and surface the error so the
      // page can drive its explicit error/empty states (error card with Retry;
      // wizard error card) without losing the page.
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
