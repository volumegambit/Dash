import { afterEach, beforeEach, vi } from 'vitest';
import { createWebFetchTool } from './web-fetch.js';

describe('createWebFetchTool', () => {
  const tool = createWebFetchTool();
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    // Mock fetch for all tests to avoid real network calls in CI
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('has correct name and description', () => {
    expect(tool.name).toBe('web_fetch');
    expect(tool.label).toBe('Web Fetch');
    expect(tool.description).toContain('Fetch content from a URL');
  });

  it('returns text content from HTML response', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response('<html><body><h1>Example Domain</h1><p>Hello world</p></body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    );

    const result = await tool.execute('call-1', { url: 'https://example.com' });

    expect(result.content).toHaveLength(1);
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('Example Domain');
    expect(text).toContain('Hello world');
    // HTML tags should be stripped
    expect(text).not.toContain('<h1>');
  });

  it('returns JSON as-is', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response('{"key": "value"}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const result = await tool.execute('call-2', { url: 'https://api.example.com/data' });
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('"key"');
    expect(text).toContain('"value"');
  });

  it('returns error for non-2xx status', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response('Not Found', { status: 404, statusText: 'Not Found' }),
    );

    const result = await tool.execute('call-3', { url: 'https://example.com/missing' });
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('Error');
    expect(text).toContain('404');
    expect(result.details).toEqual({ isError: true });
  });

  it('returns error for network failure', async () => {
    vi.mocked(globalThis.fetch).mockRejectedValue(new Error('fetch failed'));

    const result = await tool.execute('call-4', { url: 'http://unreachable.invalid' });
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('Error');
    expect(text).toContain('fetch failed');
    expect(result.details).toEqual({ isError: true });
  });

  it('strips script and style tags from HTML', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(
        '<html><head><style>body{color:red}</style></head><body><script>alert(1)</script><p>Content</p></body></html>',
        { status: 200, headers: { 'content-type': 'text/html' } },
      ),
    );

    const result = await tool.execute('call-5', { url: 'https://example.com' });
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('Content');
    expect(text).not.toContain('alert');
    expect(text).not.toContain('color:red');
  });
});
