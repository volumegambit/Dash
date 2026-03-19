import { useCallback, useEffect, useState } from 'react';
import { AVAILABLE_MODELS } from '../components/deploy-options.js';
import type { ModelOption } from '../components/deploy-options.js';
import { useSecretsStore } from '../stores/secrets.js';

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
  const keys = useSecretsStore((state) => state.keys);
  const loadKeys = useSecretsStore((state) => state.loadKeys);
  const [allModels, setAllModels] = useState<ModelOption[]>(AVAILABLE_MODELS);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (keys.length === 0) {
      loadKeys();
    }
  }, [keys.length, loadKeys]);

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
    window.api
      .modelsRefresh()
      .then((fresh) => {
        if (fresh.length > 0) {
          setAllModels(mergeModels(fresh));
        }
      })
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
