export interface ModelOption {
  value: string; // e.g. 'anthropic/claude-sonnet-4-20250514'
  label: string; // e.g. 'Claude Sonnet 4'
  provider: 'anthropic' | 'openai' | 'google';
  secretKey: string; // e.g. 'anthropic-api-key'
}

export interface ToolOption {
  value: string;
  label: string;
  description?: string;
}

/**
 * Plain-language descriptions for tools, written for non-technical users.
 * Used to enrich both the hardcoded fallback list and dynamically loaded tool IDs.
 */
/**
 * Tools that are always enabled and hidden from the user-facing tool selection UI.
 * These are internal framework tools the agent needs to function.
 */
export const ALWAYS_ENABLED_TOOLS = new Set([
  'question',
  'task',
  'todowrite',
  'skill',
]);

export const TOOL_DESCRIPTIONS: Record<string, string> = {
  bash: 'Run terminal commands on the system',
  read: 'Read files from the project',
  write: 'Create new files in the project',
  edit: 'Make changes to existing files',
  ls: 'See what files and folders exist',
  glob: 'Find files by name or pattern',
  grep: 'Search for text inside files',
  web_search: 'Search the internet for information',
  web_fetch: 'Download content from web pages',
  mcp: 'Connect to external services and tools',
  skill: 'Use specialized skill workflows',
  apply_patch: 'Apply code changes to files',
  codesearch: 'Search across the entire codebase',
  question: 'Ask the user for clarification',
  task: 'Track and manage work progress',
  todowrite: 'Create and manage to-do lists',
  load_skill: 'Load a reusable skill into the conversation',
  create_skill: 'Create reusable skills the agent remembers across conversations',
};

export const AVAILABLE_MODELS: ModelOption[] = [
  {
    value: 'anthropic/claude-opus-4-20250514',
    label: 'Claude Opus 4',
    provider: 'anthropic',
    secretKey: 'anthropic-api-key',
  },
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
  { value: 'bash', label: 'Bash', description: TOOL_DESCRIPTIONS.bash },
  { value: 'read', label: 'Read', description: TOOL_DESCRIPTIONS.read },
  { value: 'write', label: 'Write', description: TOOL_DESCRIPTIONS.write },
  { value: 'edit', label: 'Edit', description: TOOL_DESCRIPTIONS.edit },
  { value: 'ls', label: 'List Directory', description: TOOL_DESCRIPTIONS.ls },
  { value: 'glob', label: 'Glob', description: TOOL_DESCRIPTIONS.glob },
  { value: 'grep', label: 'Grep', description: TOOL_DESCRIPTIONS.grep },
  { value: 'web_search', label: 'Web Search', description: TOOL_DESCRIPTIONS.web_search },
  { value: 'web_fetch', label: 'Web Fetch', description: TOOL_DESCRIPTIONS.web_fetch },
  { value: 'mcp', label: 'MCP', description: TOOL_DESCRIPTIONS.mcp },
  { value: 'skill', label: 'Skill', description: TOOL_DESCRIPTIONS.skill },
];
