import { useCallback, useEffect, useState } from 'react';
import { AVAILABLE_MODELS } from '../components/deploy-options.js';
import type { ModelOption } from '../components/deploy-options.js';

interface UseAvailableModelsResult {
  models: ModelOption[];
  refreshing: boolean;
  refresh: () => void;
}

function mergeModels(cached: { value: string; label: string; provider: string }[]): ModelOption[] {
  const dynamic: ModelOption[] = cached.map((m) => ({
    value: m.value,
    label: m.label,
    provider: m.provider as ModelOption['provider'],
    secretKey: `${m.provider}-api-key`,
  }));
  const dynamicValues = new Set(dynamic.map((m) => m.value));
  return [...dynamic, ...AVAILABLE_MODELS.filter((m) => !dynamicValues.has(m.value))];
}

export function useAvailableModels(): UseAvailableModelsResult {
  const [keys, setKeys] = useState<string[]>([]);
  const [allModels, setAllModels] = useState<ModelOption[]>(AVAILABLE_MODELS);
  const [refreshing, setRefreshing] = useState(false);

  // Load credential keys from the gateway
  useEffect(() => {
    window.api
      .credentialsList()
      .then(setKeys)
      .catch(() => {});
  }, []);

  useEffect(() => {
    window.api
      .modelsList()
      .then((cached) => {
        if (cached.length > 0) {
          setAllModels(mergeModels(cached));
        }
      })
      .catch(() => {
        // Keep fallback AVAILABLE_MODELS
      });
  }, []);

  const refresh = useCallback(() => {
    setRefreshing(true);
    Promise.all([
      window.api.modelsRefresh().then((fresh) => {
        if (fresh.length > 0) {
          setAllModels(mergeModels(fresh));
        }
      }),
      window.api.credentialsList().then(setKeys),
    ])
      .catch(() => {
        // Keep current models on error
      })
      .finally(() => {
        setRefreshing(false);
      });
  }, []);

  const models = allModels.filter((m) => keys.some((k) => k.startsWith(`${m.secretKey}:`)));

  return { models, refreshing, refresh };
}
