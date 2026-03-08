export interface ModelOption {
  value: string; // e.g. 'anthropic/claude-sonnet-4-20250514'
  label: string; // e.g. 'Claude Sonnet 4'
  provider: 'anthropic' | 'openai' | 'google';
  secretKey: string; // e.g. 'anthropic-api-key'
}

export interface ToolOption {
  value: string;
  label: string;
}

export const AVAILABLE_MODELS: ModelOption[] = [
  {
    value: 'anthropic/claude-sonnet-4-20250514',
    label: 'Claude Sonnet 4',
    provider: 'anthropic',
    secretKey: 'anthropic-api-key',
  },
  {
    value: 'anthropic/claude-haiku-4-5-20251001',
    label: 'Claude Haiku 4.5',
    provider: 'anthropic',
    secretKey: 'anthropic-api-key',
  },
  {
    value: 'openai/gpt-4o',
    label: 'GPT-4o',
    provider: 'openai',
    secretKey: 'openai-api-key',
  },
  {
    value: 'openai/o3-mini',
    label: 'o3 mini',
    provider: 'openai',
    secretKey: 'openai-api-key',
  },
  {
    value: 'google/gemini-2.0-flash',
    label: 'Gemini 2.0 Flash',
    provider: 'google',
    secretKey: 'google-api-key',
  },
];

export const AVAILABLE_TOOLS: ToolOption[] = [
  { value: 'read_file', label: 'Read File' },
  { value: 'write_file', label: 'Write File' },
  { value: 'list_directory', label: 'List Directory' },
  { value: 'execute_command', label: 'Execute Command' },
  { value: 'web_search', label: 'Web Search' },
  { value: 'web_fetch', label: 'Web Fetch' },
];
