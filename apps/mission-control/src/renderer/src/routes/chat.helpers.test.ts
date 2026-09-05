import { describe, expect, it } from 'vitest';
import {
  formatDetails,
  formatVisibleDetails,
  insertNewlineAtSelection,
  resultSummary,
  shortenCommand,
  summarize,
  truncate,
} from './chat.helpers.js';

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

describe('insertNewlineAtSelection', () => {
  it('appends when the caret is at the end', () => {
    expect(insertNewlineAtSelection('ab', 2, 2)).toEqual({ value: 'ab\n', caret: 3 });
  });

  it('splits at the caret rather than appending', () => {
    expect(insertNewlineAtSelection('ab', 1, 1)).toEqual({ value: 'a\nb', caret: 2 });
  });

  it('replaces a selection', () => {
    expect(insertNewlineAtSelection('abcd', 1, 3)).toEqual({ value: 'a\nd', caret: 2 });
  });

  it('handles an empty draft', () => {
    expect(insertNewlineAtSelection('', 0, 0)).toEqual({ value: '\n', caret: 1 });
  });

  it('clamps indices outside the value', () => {
    expect(insertNewlineAtSelection('ab', 5, 9)).toEqual({ value: 'ab\n', caret: 3 });
    expect(insertNewlineAtSelection('ab', -3, -1)).toEqual({ value: '\nab', caret: 1 });
  });

  it('tolerates a backwards selection', () => {
    expect(insertNewlineAtSelection('abcd', 3, 1)).toEqual({ value: 'a\nd', caret: 2 });
  });

  it('falls back to the end when the selection is not a number', () => {
    expect(insertNewlineAtSelection('ab', Number.NaN, Number.NaN)).toEqual({
      value: 'ab\n',
      caret: 3,
    });
  });
});

describe('shortenCommand', () => {
  it('drops the leading directory from an absolute launcher path', () => {
    expect(shortenCommand('/opt/homebrew/bin/gog gmail list')).toBe('gog gmail list');
  });

  it('leaves a bare executable alone', () => {
    expect(shortenCommand('npm test')).toBe('npm test');
  });

  it('preserves paths that are arguments, not the executable', () => {
    expect(shortenCommand('cd /Users/gerry/x && npm test')).toBe('cd /Users/gerry/x && npm test');
  });

  it('shortens ./, ../ and ~/ launchers too', () => {
    expect(shortenCommand('./scripts/build.sh --watch')).toBe('build.sh --watch');
    expect(shortenCommand('~/bin/deploy prod')).toBe('deploy prod');
  });

  it('leaves a trailing-slash executable alone rather than emptying it', () => {
    expect(shortenCommand('/usr/bin/ ')).toBe('/usr/bin/ ');
  });
});

describe('truncate path detection', () => {
  it('does not splice a command onto its last argument', () => {
    const command = `echo ${'a'.repeat(55)} > /tmp/out.json`;
    expect(truncate(command)).toBe(`${command.slice(0, 60)}…`);
  });

  it('still middle-ellipsises a real path', () => {
    const path = `/Users/gerry/${'a'.repeat(60)}/ChatView.swift`;
    expect(truncate(path).endsWith('/ChatView.swift')).toBe(true);
    expect(truncate(path)).toContain('…');
  });
});

describe('resultSummary', () => {
  it('is empty while the tool is still running', () => {
    expect(resultSummary('bash', undefined)).toBe('');
  });

  it('shows the first line of an error, truncated', () => {
    expect(resultSummary('bash', 'ENOENT: no such file\n  at open()', true)).toBe(
      'ENOENT: no such file',
    );
  });

  it('says "failed" when an error has no text', () => {
    expect(resultSummary('bash', '   ', true)).toBe('failed');
  });

  it('stays silent for TodoWrite, whose header already carries progress', () => {
    expect(resultSummary('TodoWrite', 'ok')).toBe('');
  });

  it('counts a read result in lines, ignoring the XML envelope', () => {
    const content = '<path>a.ts</path>\n<content>\nline one\nline two\n</content>';
    expect(resultSummary('read', content)).toBe('2 lines');
  });

  it('uses the singular for one line', () => {
    expect(resultSummary('read', 'only line')).toBe('1 line');
  });

  it("prefers ls's own entry count over a line count", () => {
    expect(resultSummary('ls', '(30 entries)\nsrc/\npackage.json')).toBe('30 entries');
  });

  it('counts grep matches and names the empty case', () => {
    expect(resultSummary('grep', 'a.ts:1: hit\nb.ts:9: hit')).toBe('2 matches');
    expect(resultSummary('grep', '')).toBe('no matches');
  });

  it('counts web_search results from the numbered list it emits', () => {
    const content = '1. [One](https://a)\n   snip\n\n2. [Two](https://b)\n   snip';
    expect(resultSummary('web_search', content)).toBe('2 results');
  });

  it('reports a web_fetch body as a size', () => {
    expect(resultSummary('web_fetch', 'x'.repeat(2048))).toBe('2.0 KB');
  });

  it('reports an edit as a diff stat', () => {
    const diff = '--- a/x.ts\n+++ b/x.ts\n-old\n+new\n+also new';
    expect(resultSummary('edit', 'ok', false, { diff })).toBe('+2 -1');
  });

  it('falls back to a line count for an unknown tool', () => {
    expect(resultSummary('some_mcp_tool', 'a\nb\nc')).toBe('3 lines');
  });

  it('echoes a short single-line result verbatim', () => {
    expect(resultSummary('bash', 'done')).toBe('done');
  });

  it('names an empty result', () => {
    expect(resultSummary('bash', '\n\n')).toBe('no output');
  });
});

describe('formatVisibleDetails', () => {
  it('drops a row that repeats the header summary verbatim', () => {
    expect(formatVisibleDetails('bash', JSON.stringify({ command: 'ls -la' }))).toEqual([]);
  });

  it('applies the read skips the ToolBlock call site used to do inline', () => {
    const input = JSON.stringify({ path: 'a.ts', offset: 0, limit: 10, encoding: 'utf8' });
    expect(formatVisibleDetails('read', input)).toEqual([{ key: 'encoding', value: 'utf8' }]);
  });

  it('applies the write skips, and path repeats the header summary', () => {
    const input = JSON.stringify({ path: 'a.ts', content: 'hello' });
    expect(formatVisibleDetails('write', input)).toEqual([]);
  });

  it('drops rows whose value is only a type placeholder', () => {
    const input = JSON.stringify({ schema: { a: 1 }, items: [1, 2, 3] });
    expect(formatVisibleDetails('some_tool', input)).toEqual([]);
  });

  it('keeps the row when the header shortened the executable', () => {
    const command = '/opt/homebrew/bin/gog gmail list';
    expect(formatVisibleDetails('bash', JSON.stringify({ command }))).toEqual([
      { key: 'command', value: command },
    ]);
  });
});
