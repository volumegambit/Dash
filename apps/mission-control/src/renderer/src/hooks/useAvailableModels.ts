import { useCallback, useEffect, useState } from 'react';
import type { ModelOption } from '../components/deploy-options.js';

interface UseAvailableModelsResult {
  models: ModelOption[];
  refreshing: boolean;
  refresh: () => void;
}

/**
 * Convert a gateway model into the ModelOption shape used by the
 * dropdown components. `secretKey` is no longer used for filtering
 * (gateway already returns only what the user can use), but the
 * field is kept on the type for backwards compat with consumers
 * that still reference it.
 */
function toModelOption(m: { value: string; label: string; provider: string }): ModelOption {
  return {
    value: m.value,
    label: m.label,
    provider: m.provider as ModelOption['provider'],
    secretKey: `${m.provider}-api-key`,
  };
}

/**
 * Hook: fetch the curated model list from the gateway.
 *
 * The gateway is the single source of truth — it persistently stores
 * models, applies the SUPPORTED_MODELS allow-list filter, and returns
 * the curated bootstrap list when no provider credentials are
 * configured. MC just renders whatever it gets.
 *
 * No credential filter on the renderer side: the gateway already
 * returns only providers with credentials (or the bootstrap fallback
 * when zero credentials exist). On a cold start with no models.json
 * yet, the dropdown briefly shows an empty state until the call
 * resolves (~1-2s for a fresh provider fetch).
 */
export function useAvailableModels(): UseAvailableModelsResult {
  const [models, setModels] = useState<ModelOption[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    window.api
      .modelsList()
      .then((res) => setModels(res.models.map(toModelOption)))
      .catch(() => setModels([]));
  }, []);

  const refresh = useCallback(() => {
    setRefreshing(true);
    window.api
      .modelsRefresh()
      .then((res) => setModels(res.models.map(toModelOption)))
      .catch(() => {
        // Leave the current list in place on transient failures.
      })
      .finally(() => setRefreshing(false));
  }, []);

  return { models, refreshing, refresh };
}
