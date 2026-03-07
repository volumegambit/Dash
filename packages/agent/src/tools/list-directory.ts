import { readdir, realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Tool, ToolExecutionResult } from '../types.js';

export class ListDirectoryTool implements Tool {
  name = 'list_directory';
  definition;

  private workspace?: string;

  constructor(workspace?: string) {
    this.workspace = workspace;
    const desc = workspace
      ? `List the contents of a directory. Paths are resolved relative to the workspace directory (${workspace}). Defaults to the workspace root if no path is given.`
      : 'List the contents of a directory. Defaults to the current directory if no path is given.';
    this.definition = {
      name: 'list_directory',
      description: desc,
      input_schema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'The directory path to list. Defaults to the workspace root.',
          },
        },
        required: [],
      },
    };
  }

  async execute(input: Record<string, unknown>): Promise<ToolExecutionResult> {
    const inputPath = (input.path as string) ?? '.';

    let dirPath: string;

    if (this.workspace) {
      dirPath = resolve(this.workspace, inputPath);

      // Validate path stays within workspace
      try {
        const real = await realpath(dirPath);
        const workspaceReal = await realpath(this.workspace);
        if (!real.startsWith(`${workspaceReal}/`) && real !== workspaceReal) {
          return {
            content: `Error: path "${inputPath}" escapes the workspace directory`,
            isError: true,
          };
        }
      } catch {
        const normalized = resolve(dirPath);
        const workspaceNormalized = resolve(this.workspace);
        if (
          !normalized.startsWith(`${workspaceNormalized}/`) &&
          normalized !== workspaceNormalized
        ) {
          return {
            content: `Error: path "${inputPath}" escapes the workspace directory`,
            isError: true,
          };
        }
      }
    } else {
      dirPath = resolve(inputPath);
    }

    try {
      const entries = await readdir(dirPath);
      const lines: string[] = [];

      for (const entry of entries) {
        try {
          const s = await stat(resolve(dirPath, entry));
          lines.push(s.isDirectory() ? `${entry}/` : entry);
        } catch {
          lines.push(entry);
        }
      }

      return { content: lines.length > 0 ? lines.join('\n') : '(empty directory)' };
    } catch (error) {
      return { content: `Error listing directory: ${(error as Error).message}`, isError: true };
    }
  }
}
