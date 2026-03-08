import { useEffect, useState } from 'react';
import { AVAILABLE_MODELS } from '../components/deploy-options.js';
import type { ModelOption } from '../components/deploy-options.js';

export function useAvailableModels(): ModelOption[] {
  const [secretKeys, setSecretKeys] = useState<string[]>([]);

  useEffect(() => {
    window.api.secretsList().then(setSecretKeys).catch(() => setSecretKeys([]));
  }, []);

  return AVAILABLE_MODELS.filter((m) => secretKeys.includes(m.secretKey));
}
