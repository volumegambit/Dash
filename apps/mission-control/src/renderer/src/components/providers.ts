export type Provider = 'anthropic' | 'openai' | 'google';

export interface ProviderOption {
  id: Provider;
  name: string;
  description: string;
  available: boolean;
}

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

export const PROVIDERS: ProviderOption[] = [
  {
    id: 'anthropic',
    name: 'Claude by Anthropic',
    description: 'A powerful AI assistant known for being helpful, harmless, and honest.',
    available: true,
  },
  {
    id: 'openai',
    name: 'OpenAI (GPT-4o, o3)',
    description: 'GPT-4o and reasoning models from OpenAI.',
    available: true,
  },
  {
    id: 'google',
    name: 'Google Gemini',
    description: 'Fast and capable models from Google DeepMind.',
    available: true,
  },
];

export const PROVIDER_CONFIG: Record<Provider, ProviderConfig> = {
  anthropic: {
    title: 'Connect to Claude',
    secretKey: 'anthropic-api-key',
    placeholder: 'sk-ant-...',
    consoleUrl: 'https://console.anthropic.com',
    apiKeysUrl: 'https://console.anthropic.com/settings/keys',
    helpUrl: 'https://docs.anthropic.com/en/docs/initial-setup#prerequisites',
    helpLabel: 'How to get your API key',
    explanation:
      'To connect your agents to Claude, you need an API key. This is a secret code that gives your agents permission to use the Claude AI service.',
    steps: [
      'Click "Create Key", give it a name, and copy the key.',
      'Paste it below. It starts with sk-ant-.',
    ],
  },
  openai: {
    title: 'Connect to OpenAI',
    secretKey: 'openai-api-key',
    placeholder: 'sk-...',
    consoleUrl: 'https://platform.openai.com',
    apiKeysUrl: 'https://platform.openai.com/api-keys',
    helpUrl: 'https://platform.openai.com/docs/quickstart',
    helpLabel: 'OpenAI quickstart guide',
    explanation:
      'To use GPT-4o and other OpenAI models, you need an API key from the OpenAI platform.',
    steps: [
      'Click "Create new secret key", give it a name, and copy the key.',
      'Paste it below. It starts with sk-.',
    ],
  },
  google: {
    title: 'Connect to Google Gemini',
    secretKey: 'google-api-key',
    placeholder: 'AIza...',
    consoleUrl: 'https://aistudio.google.com',
    apiKeysUrl: 'https://aistudio.google.com/app/apikey',
    helpUrl: 'https://ai.google.dev/gemini-api/docs/quickstart',
    helpLabel: 'Gemini API quickstart',
    explanation: 'To use Gemini models, you need an API key from Google AI Studio.',
    steps: [
      'Click "Create API key", select a project, and copy the key.',
      'Paste it below. It starts with AIza.',
    ],
  },
};
