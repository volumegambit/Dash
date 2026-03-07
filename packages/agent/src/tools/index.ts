import type { Tool } from '../types.js';
import { BashTool } from './bash.js';
import { ListDirectoryTool } from './list-directory.js';
import { ReadFileTool } from './read-file.js';
import { WebFetchTool } from './web-fetch.js';
import { WebSearchTool } from './web-search.js';
import { WriteFileTool } from './write-file.js';

const toolFactories: Record<string, (workspace?: string) => Tool> = {
  bash: (workspace) => new BashTool(workspace),
  execute_command: (workspace) => new BashTool(workspace),
  read_file: (workspace) => new ReadFileTool(workspace),
  write_file: (workspace) => new WriteFileTool(workspace),
  list_directory: (workspace) => new ListDirectoryTool(workspace),
  web_fetch: () => new WebFetchTool(),
  web_search: () => new WebSearchTool(),
};

/** Resolve tool name strings to Tool instances, optionally sandboxed to a workspace */
export function resolveTools(names: string[], workspace?: string): Tool[] {
  return names.map((name) => {
    const factory = toolFactories[name];
    if (!factory) {
      throw new Error(
        `Unknown tool "${name}". Available: ${Object.keys(toolFactories).join(', ')}`,
      );
    }
    return factory(workspace);
  });
}

export { BashTool } from './bash.js';
export { ListDirectoryTool } from './list-directory.js';
export { ReadFileTool } from './read-file.js';
export { WebFetchTool } from './web-fetch.js';
export { WebSearchTool } from './web-search.js';
export { WriteFileTool } from './write-file.js';
