import { describe, expect, it } from 'vitest';
import { formatDetails, summarize } from './chat.helpers.js';

describe('summarize', () => {
  it('extracts command for bash', () => {
    expect(summarize('bash', JSON.stringify({ command: 'ls -la' }))).toBe('ls -la');
  });

  it('truncates command longer than 60 chars', () => {
    const long = 'a'.repeat(70);
    const result = summarize('bash', JSON.stringify({ command: long }));
    expect(result).toHaveLength(61); // 60 chars + ellipsis char
    expect(result.endsWith('…')).toBe(true);
  });

  it('uses middle-ellipsis for long file paths', () => {
    const longPath =
      '/Users/gerry/Projects/claude-workspace/Projects/Dash/apps/mission-control/src/renderer/src/routes/deploy.tsx';
    const result = summarize('read', JSON.stringify({ path: longPath }));
    // Should preserve the filename at the end
    expect(result).toContain('/deploy.tsx');
    expect(result).toContain('…');
    expect(result.length).toBeLessThanOrEqual(61);
  });

  it('extracts path for write_file', () => {
    expect(
      summarize('write_file', JSON.stringify({ path: 'src/index.ts', content: 'hello' })),
    ).toBe('src/index.ts');
  });

  it('extracts path for read', () => {
    expect(summarize('read', JSON.stringify({ path: 'package.json' }))).toBe('package.json');
  });

  it('extracts query for web_search', () => {
    expect(summarize('web_search', JSON.stringify({ query: 'TypeScript generics' }))).toBe(
      'TypeScript generics',
    );
  });

  it('extracts url for web_fetch', () => {
    expect(summarize('web_fetch', JSON.stringify({ url: 'https://example.com' }))).toBe(
      'https://example.com',
    );
  });

  it('falls back to first string value for unknown tool', () => {
    expect(summarize('unknown_tool', JSON.stringify({ foo: 'bar' }))).toBe('bar');
  });

  it('returns empty string on invalid JSON', () => {
    expect(summarize('bash', 'not json')).toBe('');
  });

  it('returns empty string on empty input', () => {
    expect(summarize('bash', '')).toBe('');
  });

  it('returns empty string when no matching key found', () => {
    expect(summarize('ls', JSON.stringify({}))).toBe('');
  });

  it('falls back to second key when first key is absent (grep with query)', () => {
    expect(summarize('grep', JSON.stringify({ query: 'useState' }))).toBe('useState');
  });
});

describe('formatDetails', () => {
  it('returns short strings as-is', () => {
    const result = formatDetails(JSON.stringify({ path: 'src/index.ts' }));
    expect(result).toEqual([{ key: 'path', value: 'src/index.ts' }]);
  });

  it('truncates long strings with char count', () => {
    const long = 'x'.repeat(100);
    const result = formatDetails(JSON.stringify({ content: long }));
    expect(result[0].key).toBe('content');
    expect(result[0].value).toContain('(100 chars)');
    expect(result[0].value).toContain('…');
  });

  it('formats arrays as [N items]', () => {
    const result = formatDetails(JSON.stringify({ files: ['a', 'b', 'c'] }));
    expect(result).toEqual([{ key: 'files', value: '[3 items]' }]);
  });

  it('formats nested objects as {object}', () => {
    const result = formatDetails(JSON.stringify({ opts: { a: 1 } }));
    expect(result).toEqual([{ key: 'opts', value: '{object}' }]);
  });

  it('returns multiple key-value pairs', () => {
    const result = formatDetails(JSON.stringify({ path: 'foo.ts', mode: 'write' }));
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ key: 'path', value: 'foo.ts' });
    expect(result[1]).toEqual({ key: 'mode', value: 'write' });
  });

  it('falls back gracefully on invalid JSON', () => {
    const result = formatDetails('not json');
    expect(result).toEqual([{ key: 'input', value: 'not json' }]);
  });

  it('returns fallback for null JSON value', () => {
    expect(formatDetails('null')).toEqual([{ key: 'input', value: 'null' }]);
  });

  it('returns fallback for number JSON value', () => {
    expect(formatDetails('42')).toEqual([{ key: 'input', value: '42' }]);
  });
});
