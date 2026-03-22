import hljs from 'highlight.js';
import { useMemo } from 'react';

/**
 * Renders a unified diff with color-coded added/removed lines and syntax highlighting.
 * Expects the diff format from the Edit tool:
 *   +linenum added line
 *   -linenum removed line
 *    linenum context line
 *   ... (separator)
 */
export function DiffView({ diff, path }: { diff: string; path?: string }): JSX.Element {
  const lang = path ? detectLanguage(path) : undefined;

  // Extract code from all lines → highlight as a block → split back into lines.
  // This gives highlight.js full context for multi-line tokens (template literals, etc.)
  const { lines, highlightedLines } = useMemo(() => {
    const diffLines = diff.split('\n');
    const codeLines = diffLines.map((line) => {
      if (line.trim() === '...') return '';
      const rest = line.slice(1); // skip +/-/space prefix
      const match = rest.match(/^(\s*\d+)(\s?)(.*)/);
      return match ? match[3] : rest;
    });

    const joined = codeLines.join('\n');
    try {
      const highlighted = lang
        ? hljs.highlight(joined, { language: lang }).value
        : hljs.highlightAuto(joined).value;
      return { lines: diffLines, highlightedLines: highlighted.split('\n') };
    } catch {
      return { lines: diffLines, highlightedLines: null };
    }
  }, [diff, lang]);

  return (
    <div>
      <div className="overflow-x-auto rounded bg-[#161b22] p-2">
        <pre className="text-xs leading-relaxed">
          {lines.map((line, i) => {
            const type = classifyLine(line);
            return (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: stable ordered diff lines
                key={i}
                className={lineClassName(type)}
              >
                {type === 'separator' ? (
                  <span className="select-none text-muted/40">{'⋯'}</span>
                ) : (
                  <DiffLine line={line} type={type} highlightedCode={highlightedLines?.[i]} />
                )}
              </div>
            );
          })}
        </pre>
      </div>
    </div>
  );
}

type LineType = 'added' | 'removed' | 'context' | 'separator';

function classifyLine(line: string): LineType {
  if (line.startsWith('+')) return 'added';
  if (line.startsWith('-')) return 'removed';
  if (line.trim() === '...') return 'separator';
  return 'context';
}

function lineClassName(type: LineType): string {
  switch (type) {
    case 'added':
      return 'bg-green/10';
    case 'removed':
      return 'bg-red/10';
    case 'separator':
      return '';
    case 'context':
      return '';
  }
}

function gutterClassName(type: 'added' | 'removed' | 'context'): string {
  switch (type) {
    case 'added':
      return 'select-none text-green/60';
    case 'removed':
      return 'select-none text-red/60';
    case 'context':
      return 'select-none text-muted/40';
  }
}

function DiffLine({
  line,
  type,
  highlightedCode,
}: {
  line: string;
  type: 'added' | 'removed' | 'context';
  highlightedCode?: string;
}): JSX.Element {
  const prefix = line[0]; // +, -, or space
  const rest = line.slice(1);
  const match = rest.match(/^(\s*\d+)(\s?)(.*)/);

  if (!match) {
    return <span>{line}</span>;
  }

  const lineNum = match[1];
  const space = match[2];

  // Use highlighted HTML if available, otherwise plain text
  if (highlightedCode !== undefined) {
    return (
      <>
        <span className={gutterClassName(type)}>
          {prefix}
          {lineNum}
          {space}
        </span>
        <span
          className={type === 'context' ? 'opacity-70' : undefined}
          // biome-ignore lint/security/noDangerouslySetInnerHtml: highlight.js output is safe
          dangerouslySetInnerHTML={{ __html: highlightedCode }}
        />
      </>
    );
  }

  const code = match[3];
  return (
    <>
      <span className={gutterClassName(type)}>
        {prefix}
        {lineNum}
        {space}
      </span>
      <span className={type === 'context' ? 'text-foreground/60' : undefined}>{code}</span>
    </>
  );
}

/** Map file extensions to highlight.js language names */
const EXT_TO_LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'xml',
  htm: 'xml',
  xml: 'xml',
  svg: 'xml',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'ini',
  md: 'markdown',
  mdx: 'markdown',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  fish: 'bash',
  sql: 'sql',
  graphql: 'graphql',
  gql: 'graphql',
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  lua: 'lua',
  php: 'php',
  r: 'r',
  scala: 'scala',
  ex: 'elixir',
  exs: 'elixir',
  erl: 'erlang',
  hs: 'haskell',
  ml: 'ocaml',
  mli: 'ocaml',
  vim: 'vim',
  tf: 'hcl',
  hcl: 'hcl',
  zig: 'zig',
  dart: 'dart',
  vue: 'xml',
  svelte: 'xml',
};

function detectLanguage(filePath: string): string | undefined {
  const filename = filePath.split('/').pop() ?? '';

  // Check special filenames
  const lower = filename.toLowerCase();
  if (lower === 'dockerfile') return 'dockerfile';
  if (lower === 'makefile' || lower === 'gnumakefile') return 'makefile';

  const ext = filename.includes('.') ? filename.split('.').pop()?.toLowerCase() : undefined;
  return ext ? EXT_TO_LANG[ext] : undefined;
}
