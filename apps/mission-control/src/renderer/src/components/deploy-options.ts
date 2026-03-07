export interface ModelOption {
  value: string;
  label: string;
}

export interface ToolOption {
  value: string;
  label: string;
}

export const AVAILABLE_MODELS: ModelOption[] = [
  { value: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4' },
  { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
];

export const AVAILABLE_TOOLS: ToolOption[] = [
  { value: 'read_file', label: 'Read File' },
  { value: 'write_file', label: 'Write File' },
  { value: 'list_directory', label: 'List Directory' },
  { value: 'execute_command', label: 'Execute Command' },
  { value: 'web_search', label: 'Web Search' },
  { value: 'web_fetch', label: 'Web Fetch' },
];
