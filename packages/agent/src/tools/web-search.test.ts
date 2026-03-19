import type { SearchProvider, SearchResult } from './search-providers/types.js';
import { createWebSearchTool } from './web-search.js';

function makeProvider(results: SearchResult[], error?: Error): SearchProvider {
  return {
    search: async (_query: string, _count?: number) => {
      if (error) throw error;
      return results;
    },
  };
}

describe('createWebSearchTool', () => {
  describe('when provider is null', () => {
    it('returns an error message about missing API key', async () => {
      const tool = createWebSearchTool(null);
      const result = await tool.execute('call-1', { query: 'hello' });

      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
      const text = (result.content[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('not configured');
    });
  });

  describe('with a mock provider', () => {
    it('returns formatted results', async () => {
      const provider = makeProvider([
        { title: 'First Result', url: 'https://example.com/1', snippet: 'A first snippet.' },
        { title: 'Second Result', url: 'https://example.com/2', snippet: 'A second snippet.' },
      ]);

      const tool = createWebSearchTool(provider);
      const result = await tool.execute('call-1', { query: 'test search' });

      expect(result.content).toHaveLength(1);
      const text = (result.content[0] as { type: 'text'; text: string }).text;

      expect(text).toContain('1. [First Result](https://example.com/1)');
      expect(text).toContain('A first snippet.');
      expect(text).toContain('2. [Second Result](https://example.com/2)');
      expect(text).toContain('A second snippet.');
    });

    it('handles empty results gracefully', async () => {
      const provider = makeProvider([]);

      const tool = createWebSearchTool(provider);
      const result = await tool.execute('call-1', { query: 'nothing found' });

      const text = (result.content[0] as { type: 'text'; text: string }).text;
      expect(text).toBe('No results found.');
    });

    it('handles provider errors gracefully', async () => {
      const provider = makeProvider([], new Error('Network timeout'));

      const tool = createWebSearchTool(provider);
      const result = await tool.execute('call-1', { query: 'failing query' });

      const text = (result.content[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('Web search failed');
      expect(text).toContain('Network timeout');
    });

    it('passes count parameter to provider', async () => {
      let capturedCount: number | undefined;
      const provider: SearchProvider = {
        search: async (_query, count) => {
          capturedCount = count;
          return [];
        },
      };

      const tool = createWebSearchTool(provider);
      await tool.execute('call-1', { query: 'test', count: 5 });

      expect(capturedCount).toBe(5);
    });
  });
});
