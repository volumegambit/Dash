import { useEffect, useState } from 'react';
import { AVAILABLE_MODELS } from '../components/deploy-options.js';
import type { ModelOption } from '../components/deploy-options.js';
import { useSecretsStore } from '../stores/secrets.js';

export function useAvailableModels(): ModelOption[] {
  const keys = useSecretsStore((state) => state.keys);
  const loadKeys = useSecretsStore((state) => state.loadKeys);
  const [allModels, setAllModels] = useState<ModelOption[]>(AVAILABLE_MODELS);

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
          setAllModels(
            cached.map((m) => ({
              value: m.value,
              label: m.label,
              provider: m.provider as ModelOption['provider'],
              secretKey: `${m.provider}-api-key`,
            })),
          );
        }
      })
      .catch(() => {
        // Keep fallback AVAILABLE_MODELS
      });
  }, []);

  return allModels.filter((m) => keys.some((k) => k.startsWith(`${m.secretKey}:`)));
}
