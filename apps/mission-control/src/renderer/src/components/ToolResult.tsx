import { DiffView } from './DiffView.js';

/**
 * Renders formatted tool results in the chat interface.
 * Detects patterns in raw result strings (XML tags, line numbers, file paths)
 * and renders them with appropriate styling.
 */

/** Strip XML-like wrapper tags and extract content */
function stripXmlTags(text: string): {
  path?: string;
  type?: string;
  content: string;
} {
  const pathMatch = text.match(/<path>(.*?)<\/path>/s);
  const typeMatch = text.match(/<type>(.*?)<\/type>/s);

  let content = text;
  // Remove wrapper tags
  content = content.replace(/<\/?(?:path|type|entries|content|results)>/g, '');
  // Remove "FilePath: ..." header line
  content = content.replace(/^FilePath:.*\n?/m, '');
  // Remove entry count lines like "(30 entries)"
  content = content.replace(/^\(\d+ entries?\)\s*$/m, '');
  content = content.trim();

  return {
    path: pathMatch?.[1],
    type: typeMatch?.[1],
    content,
  };
}

/** Detect if content looks like numbered source code (e.g. "  1\tconst x = 1") */
function isNumberedSource(text: string): boolean {
  const lines = text.split('\n').filter((l) => l.trim());
  if (lines.length < 2) return false;
  const numbered = lines.filter((l) => /^\s*\d+[\t|]/.test(l));
  return numbered.length > lines.length * 0.5;
}

/** Detect if content looks like a directory listing (entries ending with /) */
function isDirectoryListing(text: string): boolean {
  const lines = text.split('\n').filter((l) => l.trim());
  if (lines.length < 2) return false;
  const dirOrFile = lines.filter((l) => /^[.\w@]/.test(l.trim()));
  return dirOrFile.length > lines.length * 0.5;
}

function DirectoryListing({ content }: { content: string }): JSX.Element {
  const entries = content
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  return (
    <div className="space-y-0.5 font-mono">
      {entries.map((entry) => {
        const isDir = entry.endsWith('/');
        return (
          <div key={entry} className="flex items-center gap-1.5">
            <span className={isDir ? 'text-accent' : 'text-foreground/70'}>
              {isDir ? '📁' : '📄'}
            </span>
            <span className={isDir ? 'text-accent' : 'text-foreground/70'}>{entry}</span>
          </div>
        );
      })}
    </div>
  );
}

function SourceCode({ content }: { content: string }): JSX.Element {
  return (
    <pre className="overflow-x-auto whitespace-pre text-foreground/80">
      {content.split('\n').map((line, i) => {
        const match = line.match(/^(\s*\d+[\t|])(.*)/);
        if (match) {
          return (
            <div key={`line-${match[1].trim()}`} className="flex">
              <span className="mr-3 select-none text-muted/50">{match[1].trim()}</span>
              <span>{match[2]}</span>
            </div>
          );
        }
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: lines are ordered and stable
          <div key={i}>{line}</div>
        );
      })}
    </pre>
  );
}

export function ToolResult({
  name,
  result,
  isError,
  details,
}: { name: string; result: string; isError?: boolean; details?: unknown }): JSX.Element {
  if (isError) {
    return <p className="whitespace-pre-wrap text-red">{result}</p>;
  }

  if (!result.trim()) {
    return <p className="text-muted italic">No output</p>;
  }

  // Edit tool with diff details — render a visual diff view
  if (name === 'edit' && details && typeof details === 'object' && 'diff' in details) {
    const { diff } = details as { diff: string; firstChangedLine?: number };
    if (typeof diff === 'string' && diff.trim()) {
      // Extract path from the result text: "Successfully replaced text in <path>."
      const pathMatch = result.match(/in (.+)\.$/);
      return (
        <div>
          <p className="mb-1.5 text-green/80">{result}</p>
          <DiffView diff={diff} path={pathMatch?.[1]} />
        </div>
      );
    }
  }

  const { path, type, content } = stripXmlTags(result);

  // Directory listing
  if (type === 'directory' || (path && isDirectoryListing(content))) {
    return (
      <div>
        {path && (
          <p className="mb-1.5 truncate font-mono text-muted" title={path}>
            {path}
          </p>
        )}
        <DirectoryListing content={content} />
      </div>
    );
  }

  // File content with line numbers
  if (isNumberedSource(content)) {
    return (
      <div>
        {path && (
          <p className="mb-1.5 truncate font-mono text-muted" title={path}>
            {path}
          </p>
        )}
        <div className="overflow-x-auto rounded bg-[#161b22] p-2">
          <SourceCode content={content} />
        </div>
      </div>
    );
  }

  // Short results (< 3 lines) — render inline
  const lineCount = content.split('\n').length;
  if (lineCount <= 3) {
    return <p className="whitespace-pre-wrap text-green/80">{content}</p>;
  }

  // Long plain text — render in a scrollable code block
  return (
    <div>
      {path && (
        <p className="mb-1.5 truncate font-mono text-muted" title={path}>
          {path}
        </p>
      )}
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap text-foreground/80">{content}</pre>
    </div>
  );
}
