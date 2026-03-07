import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Tool, ToolExecutionResult } from '../types.js';

export class WriteFileTool implements Tool {
  name = 'write_file';
  definition;

  private workspace?: string;

  constructor(workspace?: string) {
    this.workspace = workspace;
    const desc = workspace
      ? `Write content to a file. Paths are resolved relative to the workspace directory (${workspace}). Creates parent directories if needed.`
      : 'Write content to a file at the given path. Creates parent directories if needed.';
    this.definition = {
      name: 'write_file',
      description: desc,
      input_schema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'The file path to write',
          },
          content: {
            type: 'string',
            description: 'The content to write to the file',
          },
        },
        required: ['path', 'content'],
      },
    };
  }

  async execute(input: Record<string, unknown>): Promise<ToolExecutionResult> {
    const inputPath = input.path as string;
    const content = input.content as string;

    if (!inputPath) return { content: 'Error: path is required', isError: true };
    if (content === undefined || content === null) {
      return { content: 'Error: content is required', isError: true };
    }

    let filePath = inputPath;

    if (this.workspace) {
      filePath = resolve(this.workspace, inputPath);

      // Validate the resolved path stays within workspace
      const workspaceReal = await realpath(this.workspace).catch(() => resolve(this.workspace!));
      const normalized = resolve(filePath);
      if (!normalized.startsWith(`${workspaceReal}/`) && normalized !== workspaceReal) {
        return {
          content: `Error: path "${inputPath}" escapes the workspace directory`,
          isError: true,
        };
      }
    }

    try {
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, content, 'utf-8');
      return { content: `Written ${content.length} characters to ${filePath}` };
    } catch (error) {
      return { content: `Error writing file: ${(error as Error).message}`, isError: true };
    }
  }
}
