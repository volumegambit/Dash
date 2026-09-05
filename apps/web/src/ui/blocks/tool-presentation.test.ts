import {
  formatDetails,
  formatVisibleDetails,
  isTodoWrite,
  middleTruncate,
  normalizeTool,
  parseTodos,
  resultSummary,
  shortenCommand,
  summarize,
  toolLabel,
} from './tool-presentation.js';

// Table tests mirror ios/DashTests/Features/ToolPresentationTests.swift
// exactly (same names, same expected values) — T5 asserts both platforms
// agree against a shared fixture corpus; keeping the two test files
// structurally parallel makes any future drift easy to spot.

describe('toolLabel', () => {
  it.each([
    ['bash', 'Bash'],
    ['read', 'Read'],
    ['write', 'Write'],
    ['edit', 'Edit'],
    ['find', 'Find'],
    ['grep', 'Grep'],
    ['ls', 'List Directory'],
    ['web_search', 'Web Search'],
    ['web_fetch', 'Web Fetch'],
    ['task', 'Task'],
    ['load_skill', 'Load Skill'],
    ['create_skill', 'Create Skill'],
  ])('maps %s to %s', (name, expected) => {
    expect(toolLabel(name)).toBe(expected);
  });

  it.each([
    ['read_file', 'Read'],
    ['write_file', 'Write'],
    ['list_directory', 'List Directory'],
    ['execute_command', 'Bash'],
  ])('normalizes legacy name %s to %s', (name, expected) => {
    expect(toolLabel(name)).toBe(expected);
  });

  it('falls back to a capitalized raw name for unknown tools', () => {
    expect(toolLabel('search')).toBe('Search');
    expect(toolLabel('custom_thing')).toBe('Custom_thing');
  });
});

describe('normalizeTool', () => {
  it.each([
    ['read_file', 'read'],
    ['write_file', 'write'],
    ['list_directory', 'ls'],
    ['execute_command', 'bash'],
    ['TodoWrite', 'todowrite'],
    ['bash', 'bash'],
  ])('normalizes %s to %s', (name, expected) => {
    expect(normalizeTool(name)).toBe(expected);
  });
});

describe('middleTruncate', () => {
  it('leaves short strings untouched', () => {
    expect(middleTruncate('ls -la')).toBe('ls -la');
  });

  it('trailing-ellipsizes long non-path strings', () => {
    const long = 'a'.repeat(70);
    const result = middleTruncate(long);
    expect(result.length).toBe(61);
    expect(result.endsWith('…')).toBe(true);
  });

  it('preserves the filename for long paths', () => {
    const longPath =
      '/Users/gerry/Projects/claude-workspace/Projects/Dash/apps/mission-control/src/renderer/src/routes/deploy.tsx';
    const result = middleTruncate(longPath);
    expect(result.endsWith('/deploy.tsx')).toBe(true);
    expect(result).toContain('…');
    expect(result.length).toBeLessThanOrEqual(61);
  });
});

describe('summarize', () => {
  it('extracts the command for bash', () => {
    expect(summarize('bash', { command: 'ls -la' })).toBe('ls -la');
  });

  it('truncates a command longer than 60 chars', () => {
    const long = 'a'.repeat(70);
    const result = summarize('bash', { command: long });
    expect(result.length).toBe(61);
    expect(result.endsWith('…')).toBe(true);
  });

  it('middle-ellipsizes long file paths', () => {
    const longPath =
      '/Users/gerry/Projects/claude-workspace/Projects/Dash/apps/mission-control/src/renderer/src/routes/deploy.tsx';
    const result = summarize('read', { path: longPath });
    expect(result).toContain('/deploy.tsx');
    expect(result).toContain('…');
  });

  it('extracts path for write', () => {
    expect(summarize('write', { path: 'src/index.ts', content: 'hello' })).toBe('src/index.ts');
  });

  it('extracts path for read', () => {
    expect(summarize('read', { path: 'package.json' })).toBe('package.json');
  });

  it('extracts query for web_search', () => {
    expect(summarize('web_search', { query: 'TypeScript generics' })).toBe('TypeScript generics');
  });

  it('extracts url for web_fetch', () => {
    expect(summarize('web_fetch', { url: 'https://example.com' })).toBe('https://example.com');
  });

  it('falls back to the second primary key when the first is absent', () => {
    expect(summarize('grep', { query: 'useState' })).toBe('useState');
  });

  it('falls back to the sole string value for an unknown tool', () => {
    expect(summarize('unknown_tool', { foo: 'bar' })).toBe('bar');
  });

  it("returns '' when input is undefined", () => {
    expect(summarize('bash', undefined)).toBe('');
  });

  it("returns '' when no matching key is found", () => {
    expect(summarize('ls', {})).toBe('');
  });

  it('reports done/total for TodoWrite', () => {
    const todos = [
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'pending' },
      { content: 'c', status: 'completed' },
    ];
    expect(summarize('task', { todos })).toBe('2/3 done');
  });
});

describe('formatDetails', () => {
  it('returns short strings as-is', () => {
    expect(formatDetails({ query: 'useState' })).toEqual([{ key: 'query', value: 'useState' }]);
  });

  it('truncates long strings with a char count', () => {
    const long = 'x'.repeat(100);
    const result = formatDetails({ note: long });
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe('note');
    expect(result[0].value).toContain('(100 chars)');
    expect(result[0].value).toContain('…');
  });

  it('formats arrays as [N items]', () => {
    expect(formatDetails({ files: ['a', 'b', 'c'] })).toEqual([
      { key: 'files', value: '[3 items]' },
    ]);
  });

  it('formats nested objects as {object}', () => {
    expect(formatDetails({ opts: { a: 1 } })).toEqual([{ key: 'opts', value: '{object}' }]);
  });

  it('returns multiple key/value pairs in insertion order', () => {
    expect(formatDetails({ path: 'foo.ts', mode: 'write' })).toEqual([
      { key: 'path', value: 'foo.ts' },
      { key: 'mode', value: 'write' },
    ]);
  });

  it('returns empty for undefined input', () => {
    expect(formatDetails(undefined)).toEqual([]);
  });
});

describe('formatVisibleDetails', () => {
  it('skips path/offset/limit for read', () => {
    const result = formatVisibleDetails('read', {
      path: 'a.txt',
      offset: 10,
      limit: 20,
      reason: 'checking contents',
    });
    expect(result).toEqual([{ key: 'reason', value: 'checking contents' }]);
  });

  it('skips content for write', () => {
    const result = formatVisibleDetails('write', { path: 'a.txt', content: 'hello world' });
    expect(result).toEqual([{ key: 'path', value: 'a.txt' }]);
  });

  it('does not filter for other tools', () => {
    const result = formatVisibleDetails('bash', { command: 'ls', path: '/tmp' });
    expect(result).toEqual([
      { key: 'command', value: 'ls' },
      { key: 'path', value: '/tmp' },
    ]);
  });
});

describe('isTodoWrite', () => {
  it.each([
    ['task', true],
    ['todowrite', true],
    ['TodoWrite', true],
    ['bash', false],
  ])('recognizes %s as %s', (name, expected) => {
    expect(isTodoWrite(name)).toBe(expected);
  });
});

describe('parseTodos', () => {
  it('extracts structured items, dropping entries without string content', () => {
    const input = {
      todos: [
        { id: '1', content: 'Write tests', status: 'completed' },
        { content: 5 },
        { content: 'Ship it' },
      ],
    };
    const todos = parseTodos(input);
    expect(todos).toHaveLength(2);
    expect(todos?.[0]).toEqual({ id: '1', content: 'Write tests', status: 'completed' });
    expect(todos?.[1]).toEqual({ content: 'Ship it' });
  });

  it('returns null when todos is missing or empty', () => {
    expect(parseTodos({})).toBeNull();
    expect(parseTodos({ todos: [] })).toBeNull();
    expect(parseTodos(undefined)).toBeNull();
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

describe('middleTruncate path detection', () => {
  it('does not splice a command onto its last argument', () => {
    const command = `echo ${'a'.repeat(55)} > /tmp/out.json`;
    expect(middleTruncate(command)).toBe(`${command.slice(0, 60)}…`);
  });

  it('still middle-ellipsises a real path', () => {
    const path = `/Users/gerry/${'a'.repeat(60)}/ChatView.swift`;
    expect(middleTruncate(path).endsWith('/ChatView.swift')).toBe(true);
    expect(middleTruncate(path)).toContain('…');
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
