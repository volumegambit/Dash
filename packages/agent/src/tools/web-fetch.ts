import type { Tool, ToolExecutionResult } from '../types.js';

const MAX_SIZE = 200 * 1024; // 200KB
const TIMEOUT_MS = 15_000;

export class WebFetchTool implements Tool {
  name = 'web_fetch';
  definition = {
    name: 'web_fetch',
    description: 'Fetch the content of a URL and return it as text.',
    input_schema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The URL to fetch',
        },
      },
      required: ['url'],
    },
  };

  async execute(input: Record<string, unknown>): Promise<ToolExecutionResult> {
    const url = input.url as string;
    if (!url) return { content: 'Error: url is required', isError: true };

    try {
      new URL(url); // validate
    } catch {
      return { content: `Error: invalid URL "${url}"`, isError: true };
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

      const response = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Dash-Agent/1.0' },
      });
      clearTimeout(timeout);

      const text = await response.text();
      const truncated = text.length > MAX_SIZE ? `${text.slice(0, MAX_SIZE)}\n\n... (truncated)` : text;

      return {
        content: `HTTP ${response.status} ${response.statusText}\n\n${truncated}`,
        isError: !response.ok,
      };
    } catch (error) {
      return { content: `Error fetching URL: ${(error as Error).message}`, isError: true };
    }
  }
}
