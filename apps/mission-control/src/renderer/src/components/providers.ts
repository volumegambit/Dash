import { providerSecretKey } from '@dash/mc/provider-keys';

// 'moonshotai' (not 'kimi'/'moonshot') and 'openrouter' match the gateway
// credential key and the pi-ai runtime provider id — keep it consistent
// end-to-end.
export type Provider = 'anthropic' | 'openai' | 'google' | 'moonshotai' | 'openrouter';

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
  {
    id: 'moonshotai',
    name: 'Kimi by Moonshot',
    description: 'Kimi K2 — strong agentic and coding models from Moonshot AI.',
    available: true,
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    description:
      'One key for many models — DeepSeek, Llama, Qwen, Grok, GLM, and more, with automatic upstream failover.',
    available: true,
  },
];

export const PROVIDER_CONFIG: Record<Provider, ProviderConfig> = {
  anthropic: {
    title: 'Connect to Claude',
    secretKey: providerSecretKey('anthropic'),
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
    secretKey: providerSecretKey('openai'),
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
    secretKey: providerSecretKey('google'),
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
  moonshotai: {
    title: 'Connect to Kimi (Moonshot)',
    secretKey: providerSecretKey('moonshotai'),
    placeholder: 'sk-...',
    consoleUrl: 'https://platform.moonshot.ai',
    apiKeysUrl: 'https://platform.moonshot.ai/console/api-keys',
    helpUrl: 'https://platform.moonshot.ai/docs/api/overview',
    helpLabel: 'Moonshot (Kimi) API docs',
    explanation:
      'To use Kimi models, you need an API key from the Moonshot AI platform (the Kimi Open Platform).',
    steps: [
      'Open the API Keys page, click "Create", and copy the key.',
      'Paste it below. It starts with sk-.',
    ],
  },
  openrouter: {
    title: 'Connect to OpenRouter',
    secretKey: providerSecretKey('openrouter'),
    // OpenRouter keys are prefixed sk-or-v1- — a plain sk- key is an OpenAI key
    // that won't route here, so the placeholder + steps steer users to the
    // right one.
    placeholder: 'sk-or-v1-...',
    consoleUrl: 'https://openrouter.ai',
    apiKeysUrl: 'https://openrouter.ai/settings/keys',
    helpUrl: 'https://openrouter.ai/docs/quickstart',
    helpLabel: 'OpenRouter quickstart',
    explanation:
      'OpenRouter routes your agents to models from many providers through a single key — reach models like DeepSeek, Llama, Qwen, Grok, and GLM without a separate account for each.',
    steps: [
      'Open the Keys page, click "Create Key", and copy the key.',
      'Paste it below. It starts with sk-or-v1-.',
    ],
  },
};
