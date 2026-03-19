import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';
import type { SearchProvider } from './search-providers/types.js';

const webSearchSchema = Type.Object({
  query: Type.String({
    description: 'The search query to look up on the internet.',
  }),
  count: Type.Optional(
    Type.Number({
      description: 'Number of results to return (default: 10, max: 20).',
      minimum: 1,
      maximum: 20,
    }),
  ),
});

type WebSearchInput = Static<typeof webSearchSchema>;

/**
 * Format an array of search results as a numbered markdown list.
 */
function formatResults(
  results: Awaited<ReturnType<SearchProvider['search']>>,
): string {
  if (results.length === 0) {
    return 'No results found.';
  }

  return results
    .map((r, i) => `${i + 1}. [${r.title}](${r.url})\n   ${r.snippet}`)
    .join('\n\n');
}

/**
 * Create the web_search tool.
 *
 * @param provider - A SearchProvider instance, or null if no API key is configured.
 */
export function createWebSearchTool(
  provider: SearchProvider | null,
): AgentTool<typeof webSearchSchema> {
  return {
    name: 'web_search',
    label: 'Web Search',
    description:
      'Search the internet and return a list of results with titles, URLs, and snippets.',
    parameters: webSearchSchema,
    execute: async (
      _toolCallId: string,
      params: WebSearchInput,
    ): Promise<AgentToolResult<Record<string, never>>> => {
      if (!provider) {
        return {
          content: [
            {
              type: 'text',
              text: 'Web search API key not configured.',
            },
          ],
          details: {},
        };
      }

      try {
        const results = await provider.search(params.query, params.count);
        return {
          content: [{ type: 'text', text: formatResults(results) }],
          details: {},
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text', text: `Web search failed: ${message}` }],
          details: {},
        };
      }
    },
  };
}
