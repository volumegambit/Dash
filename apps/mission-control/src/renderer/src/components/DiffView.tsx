/**
 * Renders a unified diff with color-coded added/removed lines.
 * Expects the diff format from the Edit tool:
 *   +linenum added line
 *   -linenum removed line
 *    linenum context line
 *   ... (separator)
 */
export function DiffView({ diff, path }: { diff: string; path?: string }): JSX.Element {
  const lines = diff.split('\n');

  return (
    <div>
      {path && (
        <p className="mb-1.5 truncate font-mono text-muted" title={path}>
          {path}
        </p>
      )}
      <div className="overflow-x-auto rounded bg-[#161b22] p-2">
        <pre className="text-xs leading-relaxed">
          {lines.map((line, i) => {
            const type = classifyLine(line);
            return (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: stable ordered diff lines
                key={i}
                className={`${type === 'added' ? 'bg-green/10 text-green' : type === 'removed' ? 'bg-red/10 text-red' : type === 'separator' ? 'text-muted/40' : 'text-foreground/60'}`}
              >
                {type === 'separator' ? (
                  <span className="select-none">{line}</span>
                ) : (
                  formatDiffLine(line, type)
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

function formatDiffLine(
  line: string,
  type: 'added' | 'removed' | 'context',
): JSX.Element {
  // Format: "+  42 some code" or "-  42 some code" or "   42 some code"
  const prefix = line[0]; // +, -, or space
  const rest = line.slice(1);
  // Split into line number and code content
  const match = rest.match(/^(\s*\d+)(\s.*|$)/);

  if (match) {
    const lineNum = match[1];
    const code = match[2];
    return (
      <>
        <span
          className={`select-none ${type === 'added' ? 'text-green/60' : type === 'removed' ? 'text-red/60' : 'text-muted/40'}`}
        >
          {prefix}
          {lineNum}
        </span>
        <span>{code}</span>
      </>
    );
  }

  return <span>{line}</span>;
}
