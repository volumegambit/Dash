export type ProviderId = 'anthropic' | 'openai' | 'google';

export interface ProviderMeta {
  id: ProviderId;
  name: string;
  secretKey: string;
  placeholder: string;
  consoleUrl: string;
  apiKeysUrl: string;
  steps: string[];
}

export const PROVIDER_METAS: ProviderMeta[] = [
  {
    id: 'anthropic',
    name: 'Claude by Anthropic',
    secretKey: 'anthropic-api-key:default',
    placeholder: 'sk-ant-...',
    consoleUrl: 'https://console.anthropic.com',
    apiKeysUrl: 'https://console.anthropic.com/settings/keys',
    steps: [
      'Sign in or create a free account.',
      'Navigate to API Keys in the dashboard.',
      'Click "Create Key", give it a name, and copy the key.',
    ],
  },
  {
    id: 'openai',
    name: 'OpenAI (GPT-4o, o3)',
    secretKey: 'openai-api-key:default',
    placeholder: 'sk-...',
    consoleUrl: 'https://platform.openai.com',
    apiKeysUrl: 'https://platform.openai.com/api-keys',
    steps: [
      'Sign in or create a free account.',
      'Navigate to API Keys in the dashboard.',
      'Click "Create new secret key", give it a name, and copy the key.',
    ],
  },
  {
    id: 'google',
    name: 'Google Gemini',
    secretKey: 'google-api-key:default',
    placeholder: 'AIza...',
    consoleUrl: 'https://aistudio.google.com',
    apiKeysUrl: 'https://aistudio.google.com/app/apikey',
    steps: [
      'Sign in or create a free account.',
      'Navigate to API Keys.',
      'Click "Create API key", select a project, and copy the key.',
    ],
  },
];

export function findProvider(input: string): ProviderMeta | undefined {
  return PROVIDER_METAS.find(
    (p) => p.id === input || p.name.toLowerCase().includes(input.toLowerCase()),
  );
}
