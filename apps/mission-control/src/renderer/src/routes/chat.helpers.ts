/** Normalize legacy tool names (read_file, write_file, etc.) to canonical names */
function normalizeTool(name: string): string {
  switch (name) {
    case 'read_file':
      return 'read';
    case 'write_file':
      return 'write';
    case 'list_directory':
      return 'ls';
    case 'execute_command':
      return 'bash';
    case 'TodoWrite':
      return 'todowrite';
    default:
      return name;
  }
}

export interface TodoItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

/** Check if tool name is TodoWrite */
export function isTodoWrite(name: string): boolean {
  const n = normalizeTool(name);
  return n === 'task' || n === 'todowrite';
}

/** Parse TodoWrite input JSON into structured todo items, or null if parsing fails */
export function parseTodos(input: string): TodoItem[] | null {
  try {
    const parsed = JSON.parse(input) as Record<string, unknown>;
    const todos = parsed.todos;
    if (!Array.isArray(todos) || todos.length === 0) return null;
    return todos.filter(
      (t): t is TodoItem =>
        typeof t === 'object' && t !== null && typeof (t as TodoItem).content === 'string',
    );
  } catch {
    return null;
  }
}

const TOOL_LABELS: Record<string, string> = {
  bash: 'Bash',
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  find: 'Find',
  grep: 'Grep',
  ls: 'List Directory',
  web_search: 'Web Search',
  web_fetch: 'Web Fetch',
  task: 'Task',
  load_skill: 'Load Skill',
  create_skill: 'Create Skill',
};

/** Return a human-friendly label for a tool name */
export function toolLabel(name: string): string {
  const n = normalizeTool(name);
  return TOOL_LABELS[n] ?? name.charAt(0).toUpperCase() + name.slice(1);
}

const PRIMARY_KEYS: Record<string, string[]> = {
  bash: ['command'],
  write: ['path'],
  edit: ['path'],
  read: ['path'],
  find: ['pattern'],
  grep: ['pattern', 'query'],
  ls: ['path', 'directory'],
  web_search: ['query'],
  web_fetch: ['url'],
  task: ['todos'],
  load_skill: ['name'],
  create_skill: ['name'],
};

function isPathLike(s: string): boolean {
  return s.includes('/') && !/\s/.test(s);
}

/** Truncate `s` to `max` characters. For path-like strings — containing "/"
 * and no whitespace — uses a middle-ellipsis that preserves the trailing
 * filename.
 *
 * The whitespace test is load-bearing, not a nicety. Keying the branch off
 * `includes('/')` alone, as this did until 2026-09-05, makes a shell
 * command's LAST slash — which usually sits inside a trailing argument —
 * look like a path separator. The result spliced the command's head onto
 * that argument's tail and rendered a plausible path
 * ("/opt/homebrew/bin/gog gmail li…/out.json") that never existed. A string
 * with spaces in it is a command or a sentence, not a path; plain tail
 * truncation is the honest rendering. Ported from the iOS twin, which found
 * this first. */
export function truncate(s: string, max = 60): string {
  if (s.length <= max) return s;

  if (isPathLike(s)) {
    const lastSlash = s.lastIndexOf('/');
    const filename = s.slice(lastSlash); // includes the leading /
    const prefix = s.slice(0, max - filename.length - 1);
    if (prefix.length > 3) {
      return `${prefix}…${filename}`;
    }
  }

  return `${s.slice(0, max)}…`;
}

/** Drop the leading directory from a shell command's executable, so
 * `/opt/homebrew/bin/gog gmail list` summarizes as `gog gmail list`.
 *
 * A collapsed row gets roughly 40 characters on a phone. An absolute
 * launcher path spends the first ~18 of them on a prefix identical across
 * every call to the same binary, so consecutive calls are indistinguishable
 * until you expand them. The directory is not information the reader is
 * missing — it is on `$PATH` — so it goes, and the arguments that actually
 * differ move into view.
 *
 * Only the first whitespace-delimited word is touched, and only when it
 * reads as a launcher path (absolute, `./`, `../` or `~/`). Everything after
 * it is preserved byte-for-byte: `cd /Users/gerry/x && npm test` keeps its
 * path, because that path is an argument the user chose, not an install
 * location. Ported from the iOS twin. */
export function shortenCommand(command: string): string {
  const match = command.match(/^\S+/);
  if (!match) return command;
  const executable = match[0];
  if (!/^(\/|\.\/|\.\.\/|~\/)/.test(executable)) return command;
  const name = executable.slice(executable.lastIndexOf('/') + 1);
  if (!name) return command;
  return name + command.slice(executable.length);
}

export function summarize(name: string, input: string): string {
  if (!input) return '';
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(input) as Record<string, unknown>;
  } catch {
    return '';
  }

  // Custom summary for TodoWrite: show completion count
  if (isTodoWrite(name)) {
    const todos = parseTodos(input);
    if (todos) {
      const done = todos.filter((t) => t.status === 'completed').length;
      return `${done}/${todos.length} done`;
    }
  }

  const normalized = normalizeTool(name);
  const keys = PRIMARY_KEYS[normalized] ?? [];
  for (const key of keys) {
    const val = parsed[key];
    // Shorten BEFORE truncating: otherwise `/opt/homebrew/bin/` spends 18 of
    // the 60-character budget before the command even starts.
    if (typeof val === 'string' && val) {
      return truncate(normalized === 'bash' ? shortenCommand(val) : val);
    }
  }

  // Fallback: first string value in the object
  for (const val of Object.values(parsed)) {
    if (typeof val === 'string' && val) return truncate(val);
  }

  return '';
}

export function formatDetails(input: string): { key: string; value: string }[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return [{ key: 'input', value: input }];
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return [{ key: 'input', value: input }];
  }

  return Object.entries(parsed as Record<string, unknown>).map(([key, val]) => {
    if (typeof val === 'string') {
      if (val.length > 80) return { key, value: `"${val.slice(0, 80)}…" (${val.length} chars)` };
      return { key, value: val };
    }
    if (Array.isArray(val)) return { key, value: `[${val.length} items]` };
    if (typeof val === 'object' && val !== null) return { key, value: '{object}' };
    return { key, value: String(val) };
  });
}

/**
 * Splices a newline into `value` at the caret/selection, returning the new
 * value and where the caret should land.
 *
 * Deliberately duplicated in the web app's `ui/composer.ts`: the two apps
 * share no UI package, and a cross-package dependency for eight lines of
 * index arithmetic would cost more than the duplication does. If a third
 * consumer appears, that is the moment to extract it.
 */
export function insertNewlineAtSelection(
  value: string,
  selectionStart: number,
  selectionEnd: number,
): { value: string; caret: number } {
  const max = value.length;
  const rawStart = Number.isFinite(selectionStart) ? selectionStart : max;
  const rawEnd = Number.isFinite(selectionEnd) ? selectionEnd : max;
  const a = Math.min(Math.max(rawStart, 0), max);
  const b = Math.min(Math.max(rawEnd, 0), max);
  const start = Math.min(a, b);
  const end = Math.max(a, b);

  return {
    value: `${value.slice(0, start)}\n${value.slice(end)}`,
    caret: start + 1,
  };
}

/** Remove the chrome some tools wrap their result body in, so a line count
 * counts the body and not the envelope.
 *
 * `<path>`/`<type>` are dropped ELEMENT AND CONTENT — they are metadata the
 * collapsed header already shows, and leaving the text behind would make a
 * two-line file read as four. The remaining tags are pure wrappers, so only
 * the tags go. Twin of the web port's `stripResultChrome`; both descend from this app's own
 * `stripXmlTags` (`components/ToolResult.tsx`), which has done this for
 * result RENDERING since before the port — this one exists to make the
 * counting agree across clients. */
export function stripResultChrome(content: string): string {
  return content
    .replace(/<(path|type)>[\s\S]*?<\/\1>\n?/g, '')
    .replace(/<\/?(?:entries|content|results)>\n?/g, '')
    .replace(/^FilePath:.*\n?/m, '')
    .replace(/^\(\d+ entries?\)\n?/m, '')
    .trim();
}

/** Lines in `content`, ignoring leading and trailing blank lines. 0 for
 * blank input — a trailing newline is an artifact of command output, not a
 * line of it. */
export function countLines(content: string): number {
  const trimmed = content.trim();
  return trimmed ? trimmed.split('\n').length : 0;
}

function firstLine(content: string): string {
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Human byte size: `512 B`, `4.2 KB`, `1.3 MB`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** `+added -removed` from an edit tool's `details.diff`, or '' when there is
 * no usable diff. `+++`/`---` are unified-diff FILE HEADERS, not content, so
 * they are excluded — counting them would report every one-line edit as
 * `+2 -2`. The hyphen is ASCII U+002D, not a U+2212 minus: three platforms
 * render this string and an encoding is one more thing they could disagree
 * about. */
export function diffStat(details: unknown): string {
  if (typeof details !== 'object' || details === null) return '';
  const diff = (details as { diff?: unknown }).diff;
  if (typeof diff !== 'string' || !diff) return '';
  let added = 0;
  let removed = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added++;
    else if (line.startsWith('-')) removed++;
  }
  if (added === 0 && removed === 0) return '';
  return `+${added} -${removed}`;
}

/** What came back, for the right edge of a collapsed tool row — the half of
 * the card `summarize` cannot answer, because `summarize` reads only the
 * tool's INPUT.
 *
 * Heuristic by necessity: the backend flattens a tool's content blocks into
 * one opaque string (`packages/agent/src/backends/piagent.ts`), so there is
 * no structured result to read. Every branch below is keyed to a shape this
 * repo's own tools actually emit — `web_search`'s numbered list comes from
 * `formatResults` in `packages/agent/src/tools/web-search.ts`, `ls`'s
 * `(N entries)` from the listing tool. The fallback is deliberately dull:
 * a third-party MCP tool's output is only reliably "some text", and
 * "N lines" is true of any text.
 *
 * Twin of `tool-presentation.ts` `resultSummary` on web and
 * `ToolPresentation.resultSummary` on iOS; those two are pinned against each
 * other by `scripts/fixtures/rendering-fixtures.json`, and this copy is held
 * to the same cases by the tests beside it. */
export function resultSummary(
  name: string,
  content: string | undefined,
  isError = false,
  details?: unknown,
): string {
  if (content === undefined) return '';

  if (isError) {
    const line = firstLine(content);
    return line ? truncate(line, 40) : 'failed';
  }

  // A task card's header already reads "2/3 done" plus the active item, and
  // its body is a rendered checklist. An outcome would be a third account of
  // the same thing.
  if (isTodoWrite(name)) return '';

  const normalized = normalizeTool(name);
  if (normalized === 'edit') return diffStat(details);

  const body = stripResultChrome(content);

  switch (normalized) {
    case 'read':
      return plural(countLines(body), 'line', 'lines');
    case 'ls': {
      // The listing tool states its own count; trust it over a line count,
      // which would also count any header or trailing note.
      const declared = content.match(/\((\d+) entries?\)/);
      const count = declared ? Number(declared[1]) : countLines(body);
      return plural(count, 'entry', 'entries');
    }
    case 'grep':
    case 'find': {
      const count = countLines(body);
      return count === 0 ? 'no matches' : plural(count, 'match', 'matches');
    }
    case 'web_search': {
      const count = (body.match(/^\d+\. \[/gm) ?? []).length;
      return count === 0 ? 'no results' : plural(count, 'result', 'results');
    }
    case 'web_fetch':
      return formatBytes(new TextEncoder().encode(body).length);
    default: {
      const count = countLines(body);
      if (count === 0) return 'no output';
      // One short line IS the outcome — "ok", "done", an exit message. Saying
      // "1 line" instead would be strictly less information for the same width.
      if (count === 1 && body.length <= 40) return body;
      return plural(count, 'line', 'lines');
    }
  }
}
