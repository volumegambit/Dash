import type { SearchProvider, SearchResult } from './types.js';

const BRAVE_SEARCH_URL = 'https://api.search.brave.com/res/v1/web/search';

interface BraveWebResult {
  title: string;
  url: string;
  description?: string;
  extra_snippets?: string[];
}

interface BraveSearchResponse {
  web?: {
    results?: BraveWebResult[];
  };
}

/**
 * SearchProvider implementation using the Brave Search API.
 * Requires a valid Brave Search API key.
 */
export class BraveSearchProvider implements SearchProvider {
  constructor(private apiKey: string) {}

  async search(query: string, count = 10): Promise<SearchResult[]> {
    const params = new URLSearchParams({ q: query, count: String(count) });
    const url = `${BRAVE_SEARCH_URL}?${params}`;

    const response = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': this.apiKey,
      },
    });

    if (!response.ok) {
      throw new Error(
        `Brave Search API error: ${response.status} ${response.statusText}`,
      );
    }

    const data = (await response.json()) as BraveSearchResponse;
    const rawResults = data.web?.results ?? [];

    return rawResults.map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.description ?? r.extra_snippets?.[0] ?? '',
    }));
  }
}
