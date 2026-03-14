import { AVAILABLE_MODELS } from '../components/deploy-options.js';
import type { ModelOption } from '../components/deploy-options.js';
import { useSecretsStore } from '../stores/secrets.js';

export function useAvailableModels(): ModelOption[] {
  const keys = useSecretsStore((state) => state.keys);
  return AVAILABLE_MODELS.filter((m) => keys.some((k) => k.startsWith(`${m.secretKey}:`)));
}
