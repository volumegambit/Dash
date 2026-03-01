import type { Tool } from '../types.js';
import { BashTool } from './bash.js';
import { ReadFileTool } from './read-file.js';

const toolFactories: Record<string, (workspace?: string) => Tool> = {
  bash: (workspace) => new BashTool(workspace),
  read_file: (workspace) => new ReadFileTool(workspace),
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
export { ReadFileTool } from './read-file.js';
