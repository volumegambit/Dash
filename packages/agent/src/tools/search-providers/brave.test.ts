import { BraveSearchProvider } from './brave.js';

describe('BraveSearchProvider', () => {
  it('throws on invalid API key', async () => {
    const provider = new BraveSearchProvider('invalid-key');

    // Stub fetch to return a 401 Unauthorized response
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ message: 'Unauthorized' }), {
        status: 401,
        statusText: 'Unauthorized',
      });

    try {
      await expect(provider.search('test query')).rejects.toThrow(
        'Brave Search API error: 401 Unauthorized',
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('maps web results to SearchResult[]', async () => {
    const provider = new BraveSearchProvider('valid-key');

    const mockResponse = {
      web: {
        results: [
          { title: 'Result One', url: 'https://example.com/1', description: 'First snippet' },
          { title: 'Result Two', url: 'https://example.com/2', description: 'Second snippet' },
        ],
      },
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify(mockResponse), { status: 200 });

    try {
      const results = await provider.search('test query');
      expect(results).toHaveLength(2);
      expect(results[0]).toEqual({
        title: 'Result One',
        url: 'https://example.com/1',
        snippet: 'First snippet',
      });
      expect(results[1]).toEqual({
        title: 'Result Two',
        url: 'https://example.com/2',
        snippet: 'Second snippet',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('falls back to extra_snippets when description is missing', async () => {
    const provider = new BraveSearchProvider('valid-key');

    const mockResponse = {
      web: {
        results: [
          {
            title: 'No Desc',
            url: 'https://example.com',
            extra_snippets: ['fallback snippet'],
          },
        ],
      },
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify(mockResponse), { status: 200 });

    try {
      const results = await provider.search('test');
      expect(results[0].snippet).toBe('fallback snippet');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('returns empty array when web.results is absent', async () => {
    const provider = new BraveSearchProvider('valid-key');

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({}), { status: 200 });

    try {
      const results = await provider.search('nothing');
      expect(results).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
