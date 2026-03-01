import { exec } from 'node:child_process';
import type { Tool, ToolExecutionResult } from '../types.js';

const MAX_OUTPUT = 100 * 1024; // 100KB
const TIMEOUT_MS = 30_000;

export class BashTool implements Tool {
  name = 'bash';
  definition;

  private workspace?: string;

  constructor(workspace?: string) {
    this.workspace = workspace;
    const desc = workspace
      ? `Execute a shell command in the workspace directory (${workspace}). Use for system commands, file operations, or running scripts.`
      : 'Execute a shell command and return its output. Use for system commands, file operations, or running scripts.';
    this.definition = {
      name: 'bash',
      description: desc,
      input_schema: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'The shell command to execute',
          },
        },
        required: ['command'],
      },
    };
  }

  async execute(input: Record<string, unknown>): Promise<ToolExecutionResult> {
    const command = input.command as string;
    if (!command) {
      return { content: 'Error: command is required', isError: true };
    }

    return new Promise((resolve) => {
      const opts: { timeout: number; maxBuffer: number; cwd?: string } = {
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT,
      };
      if (this.workspace) {
        opts.cwd = this.workspace;
      }
      exec(command, opts, (error, stdout, stderr) => {
        if (error) {
          const output = [stderr, stdout, error.message].filter(Boolean).join('\n').trim();
          resolve({ content: output || 'Command failed', isError: true });
          return;
        }
        const output = [stdout, stderr].filter(Boolean).join('\n').trim();
        resolve({ content: output || '(no output)' });
      });
    });
  }
}
