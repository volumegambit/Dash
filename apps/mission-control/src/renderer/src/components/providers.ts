export type Provider = 'anthropic';

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
};
