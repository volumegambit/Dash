import type { Tool, ToolExecutionResult } from '../types.js';

const TIMEOUT_MS = 10_000;

interface DdgResult {
  Text?: string;
  FirstURL?: string;
  Topics?: Array<{ Text?: string; FirstURL?: string }>;
  RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>;
}

export class WebSearchTool implements Tool {
  name = 'web_search';
  definition = {
    name: 'web_search',
    description: 'Search the web for a query and return relevant results.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query',
        },
      },
      required: ['query'],
    },
  };

  async execute(input: Record<string, unknown>): Promise<ToolExecutionResult> {
    const query = input.query as string;
    if (!query) return { content: 'Error: query is required', isError: true };

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

      const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_redirect=1&no_html=1`;
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Dash-Agent/1.0' },
      });
      clearTimeout(timeout);

      if (!response.ok) {
        return { content: `Search failed: HTTP ${response.status}`, isError: true };
      }

      const data = (await response.json()) as DdgResult;
      const lines: string[] = [];

      // Instant answer
      if (data.Text) {
        lines.push(`Answer: ${data.Text}`);
        if (data.FirstURL) lines.push(`Source: ${data.FirstURL}`);
        lines.push('');
      }

      // Related topics
      const topics = [...(data.Topics ?? []), ...(data.RelatedTopics ?? [])].slice(0, 8);
      if (topics.length > 0) {
        lines.push('Related results:');
        for (const topic of topics) {
          if (topic.Text) {
            lines.push(`- ${topic.Text}`);
            if (topic.FirstURL) lines.push(`  ${topic.FirstURL}`);
          }
        }
      }

      const content = lines.join('\n').trim();
      return {
        content: content || `No results found for "${query}". Try a more specific query or use web_fetch to visit a URL directly.`,
      };
    } catch (error) {
      return { content: `Error searching: ${(error as Error).message}`, isError: true };
    }
  }
}
