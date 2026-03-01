import { readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Tool, ToolExecutionResult } from '../types.js';

const MAX_SIZE = 500 * 1024; // 500KB

export class ReadFileTool implements Tool {
  name = 'read_file';
  definition;

  private workspace?: string;

  constructor(workspace?: string) {
    this.workspace = workspace;
    const desc = workspace
      ? `Read the contents of a file. Paths are resolved relative to the workspace directory (${workspace}).`
      : 'Read the contents of a file at the given path.';
    this.definition = {
      name: 'read_file',
      description: desc,
      input_schema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'The file path to read',
          },
        },
        required: ['path'],
      },
    };
  }

  async execute(input: Record<string, unknown>): Promise<ToolExecutionResult> {
    const inputPath = input.path as string;
    if (!inputPath) {
      return { content: 'Error: path is required', isError: true };
    }

    let filePath = inputPath;

    if (this.workspace) {
      // Resolve relative to workspace
      filePath = resolve(this.workspace, inputPath);

      // Validate the resolved path stays within workspace
      try {
        const real = await realpath(filePath);
        const workspaceReal = await realpath(this.workspace);
        if (!real.startsWith(workspaceReal + '/') && real !== workspaceReal) {
          return {
            content: `Error: path "${inputPath}" escapes the workspace directory`,
            isError: true,
          };
        }
      } catch {
        // File doesn't exist — still validate the resolved path lexically
        const normalized = resolve(filePath);
        const workspaceNormalized = resolve(this.workspace);
        if (
          !normalized.startsWith(workspaceNormalized + '/') &&
          normalized !== workspaceNormalized
        ) {
          return {
            content: `Error: path "${inputPath}" escapes the workspace directory`,
            isError: true,
          };
        }
      }
    }

    try {
      const content = await readFile(filePath, 'utf-8');
      if (content.length > MAX_SIZE) {
        return {
          content: `${content.slice(0, MAX_SIZE)}\n\n... (truncated at 500KB)`,
        };
      }
      return { content: content || '(empty file)' };
    } catch (error) {
      return {
        content: `Error reading file: ${(error as Error).message}`,
        isError: true,
      };
    }
  }
}
