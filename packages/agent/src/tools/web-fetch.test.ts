import { createWebFetchTool } from './web-fetch.js';

describe('createWebFetchTool', () => {
  const tool = createWebFetchTool();

  it('has correct name and description', () => {
    expect(tool.name).toBe('web_fetch');
    expect(tool.label).toBe('Web Fetch');
    expect(tool.description).toBe(
      'Fetch content from a URL. Returns the text content of the page.',
    );
  });

  it('fetches example.com and returns text containing "Example Domain"', async () => {
    const result = await tool.execute('call-1', { url: 'https://example.com' });

    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('Example Domain');
    expect(result.details).not.toHaveProperty('isError');
  }, 15_000);

  it('returns error for invalid URL', async () => {
    const result = await tool.execute('call-2', { url: 'not-a-valid-url' });

    expect(result.content).toHaveLength(1);
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toMatch(/^Error:/);
    expect(result.details).toEqual({ isError: true });
  });

  it('returns error for unreachable host', async () => {
    const result = await tool.execute('call-3', {
      url: 'http://this-host-does-not-exist-abc123xyz.invalid',
    });

    expect(result.content).toHaveLength(1);
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toMatch(/^Error:/);
    expect(result.details).toEqual({ isError: true });
  }, 15_000);
});
